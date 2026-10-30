use std::{
  cell::RefCell,
  collections::{BTreeMap, HashMap},
};

use llm_adapter::backend::{BackendError, BackendHttpClient, DefaultHttpClient, HttpBody, HttpRequest, HttpResponse};
use serde_json::{Value, json};

/// One instance per execution, including every round of its tool loop.
pub(super) struct CopilotHttpClient<H = DefaultHttpClient> {
  enabled: bool,
  inner: H,
  replay: RefCell<Option<Vec<Value>>>,
}

fn failure(message: impl Into<String>) -> BackendError {
  BackendError::Transport {
    message: format!("chatgpt_plan: {}", message.into()),
  }
}

impl CopilotHttpClient {
  pub(super) fn new(enabled: bool) -> Self {
    Self {
      enabled,
      inner: DefaultHttpClient::default(),
      replay: RefCell::new(None),
    }
  }
}

impl<H: BackendHttpClient> CopilotHttpClient<H> {
  fn prepare(&self, mut request: HttpRequest) -> Result<HttpRequest, BackendError> {
    if request.url != "https://api.openai.com/v1/responses" {
      return Err(failure("unsupported endpoint"));
    }
    let HttpBody::Json(body) = &mut request.body else {
      return Err(failure("multipart requests are not supported"));
    };
    normalize(body)?;
    let input = body["input"]
      .as_array_mut()
      .ok_or_else(|| failure("input must be an array"))?;
    if let Some(previous) = self.replay.borrow().as_ref() {
      let calls = previous
        .iter()
        .filter(|item| item["type"] == "function_call")
        .filter_map(|item| item["call_id"].as_str())
        .collect::<std::collections::HashSet<_>>();
      let existing_outputs = previous
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .filter_map(|item| item["call_id"].as_str())
        .collect::<std::collections::HashSet<_>>();
      let outputs = input
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .filter(|item| {
          item["call_id"]
            .as_str()
            .is_some_and(|id| calls.contains(id) && !existing_outputs.contains(id))
        })
        .cloned()
        .collect::<Vec<_>>();
      if outputs.is_empty() || outputs.len() != calls.difference(&existing_outputs).count() {
        return Err(failure("tool continuation is missing its outputs"));
      }
      *input = previous.clone();
      input.extend(outputs);
    }
    Ok(request)
  }

  fn stream(
    &self,
    request: HttpRequest,
    on_chunk: &mut dyn FnMut(&str) -> Result<(), BackendError>,
  ) -> Result<Value, BackendError> {
    let request = self.prepare(request)?;
    let mut history = request.body.as_json().unwrap()["input"].as_array().unwrap().clone();
    let mut decoder = CompletionGuard::default();
    self.inner.post_sse(request, &mut |chunk| {
      for frame in decoder.push(chunk)? {
        on_chunk(&frame)?;
      }
      Ok(())
    })?;
    let completed = decoder.finish()?;
    history.extend(completed["output"].as_array().cloned().unwrap_or_default());
    self.replay.replace(Some(history));
    Ok(completed)
  }
}

impl<H: BackendHttpClient> BackendHttpClient for CopilotHttpClient<H> {
  fn post_json(&self, request: HttpRequest) -> Result<HttpResponse, BackendError> {
    if !self.enabled {
      return self.inner.post_json(request);
    }
    let body = self.stream(request, &mut |_| Ok(()))?;
    Ok(HttpResponse { status: 200, body })
  }

  fn post_sse(
    &self,
    request: HttpRequest,
    on_chunk: &mut dyn FnMut(&str) -> Result<(), BackendError>,
  ) -> Result<(), BackendError> {
    if !self.enabled {
      return self.inner.post_sse(request, on_chunk);
    }
    self.stream(request, on_chunk).map(|_| ())
  }

  fn execute(
    &self,
    request: llm_adapter::backend::HttpRawRequest,
  ) -> Result<llm_adapter::backend::HttpRawResponse, BackendError> {
    if self.enabled {
      return Err(failure("unsupported operation"));
    }
    self.inner.execute(request)
  }

  fn put_bytes(&self, request: llm_adapter::backend::HttpUploadRequest) -> Result<(), BackendError> {
    if self.enabled {
      return Err(failure("file uploads are not supported"));
    }
    self.inner.put_bytes(request)
  }
}

fn normalize(body: &mut Value) -> Result<(), BackendError> {
  let object = body
    .as_object_mut()
    .ok_or_else(|| failure("request must be an object"))?;
  for field in [
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
    "previous_response_id",
  ] {
    object.remove(field);
  }
  object.insert("store".into(), json!(false));
  object.insert("stream".into(), json!(true));
  object.insert("include".into(), json!(["reasoning.encrypted_content"]));
  let tools = object.remove("tools");
  let input = object
    .get_mut("input")
    .and_then(Value::as_array_mut)
    .ok_or_else(|| failure("input must be an array"))?;
  for item in input.iter_mut() {
    if item["role"] == "system" {
      item["role"] = json!("developer");
    }
  }
  if let Some(tools) = tools.and_then(|tools| tools.as_array().cloned()) {
    if tools
      .iter()
      .any(|tool| tool["type"] != "function" && tool["type"] != "custom")
    {
      return Err(failure("unsupported hosted tool"));
    }
    if !tools.is_empty() {
      input.insert(0, json!({"type":"additional_tools","role":"developer","tools":tools}));
    }
  }
  Ok(())
}

#[derive(Default)]
struct CompletionGuard {
  buffer: String,
  completed: Option<Value>,
  output_items: BTreeMap<u64, Value>,
  tool_call_ids: HashMap<String, String>,
}

impl CompletionGuard {
  fn push(&mut self, chunk: &str) -> Result<Vec<String>, BackendError> {
    self.buffer.extend(chunk.chars().filter(|ch| *ch != '\r'));
    if self.buffer.len() > 16 * 1024 * 1024 {
      return Err(failure("SSE event exceeded the size limit"));
    }
    let mut frames = Vec::new();
    while let Some(end) = self.buffer.find("\n\n") {
      let frame: String = self.buffer.drain(..end + 2).collect();
      let data = frame
        .lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
        .collect::<Vec<_>>()
        .join("\n");
      if data.is_empty() || data == "[DONE]" {
        continue;
      }
      let mut event: Value = serde_json::from_str(&data).map_err(|_| failure("invalid SSE event"))?;
      if self.completed.is_some() {
        return Err(failure("event after completion"));
      }
      match event["type"].as_str().unwrap_or("") {
        "response.failed" | "response.incomplete" | "error" => {
          let code = event
            .pointer("/response/error/code")
            .or_else(|| event.pointer("/error/code"))
            .or_else(|| event.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("incomplete_response");
          return Err(failure(format!("{code}; check ChatGPT connection and usage settings")));
        }
        "response.completed" => {
          if self.completed.is_some() || !event["response"].is_object() {
            return Err(failure("invalid completion event"));
          }
          // Some SIWC streams finalize each output item separately and leave
          // response.completed.output empty. Retain the finalized items (including
          // encrypted reasoning) for both tool replay and structured decoding.
          let output = event["response"]["output"]
            .as_array_mut()
            .ok_or_else(|| failure("invalid completion output"))?;
          if output.is_empty() && !self.output_items.is_empty() {
            if self.output_items.keys().copied().ne(0..self.output_items.len() as u64) {
              return Err(failure("stream is missing finalized output items"));
            }
            output.extend(self.output_items.values().cloned());
          }
          self.completed = Some(event["response"].clone());
        }
        "response.output_item.added" | "response.output_item.done" => {
          let item = &event["item"];
          if item["type"] == "function_call" {
            let id = item["id"].as_str().ok_or_else(|| failure("missing tool item ID"))?;
            let call_id = item["call_id"]
              .as_str()
              .ok_or_else(|| failure("missing tool call ID"))?;
            self.tool_call_ids.insert(id.into(), call_id.into());
          }
          if event["type"] == "response.output_item.done" {
            let index = event["output_index"]
              .as_u64()
              .ok_or_else(|| failure("missing output index"))?;
            if !item.is_object() || self.output_items.insert(index, item.clone()).is_some() {
              return Err(failure("invalid finalized output item"));
            }
          }
        }
        "response.function_call_arguments.delta" | "response.function_call_arguments.done" => {
          // The generic adapter expects call_id, while Responses argument events
          // reference the output item's ID. Resolve it before feeding that parser.
          if let Some(item_id) = event["item_id"].as_str() {
            let call_id = self
              .tool_call_ids
              .get(item_id)
              .ok_or_else(|| failure("unknown tool item ID"))?;
            event["call_id"] = json!(call_id);
          }
        }
        _ => {}
      }
      frames.push(format!("data: {event}\n\n"));
    }
    Ok(frames)
  }

  fn finish(self) -> Result<Value, BackendError> {
    if !self.buffer.trim().is_empty() {
      return Err(failure("stream interrupted inside an event"));
    }
    self
      .completed
      .ok_or_else(|| failure("stream ended without response.completed"))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  struct FakeHttp {
    requests: RefCell<Vec<Value>>,
    responses: RefCell<std::collections::VecDeque<Vec<String>>>,
  }
  impl BackendHttpClient for FakeHttp {
    fn post_json(&self, _: HttpRequest) -> Result<HttpResponse, BackendError> {
      panic!("SIWC must always stream")
    }
    fn post_sse(
      &self,
      request: HttpRequest,
      callback: &mut dyn FnMut(&str) -> Result<(), BackendError>,
    ) -> Result<(), BackendError> {
      self.requests.borrow_mut().push(request.body.as_json().unwrap().clone());
      for frame in self.responses.borrow_mut().pop_front().unwrap() {
        callback(&frame)?;
      }
      Ok(())
    }
  }
  fn client(responses: Vec<Vec<String>>) -> CopilotHttpClient<FakeHttp> {
    CopilotHttpClient {
      enabled: true,
      inner: FakeHttp {
        requests: RefCell::new(vec![]),
        responses: RefCell::new(responses.into()),
      },
      replay: RefCell::new(None),
    }
  }
  fn request(input: Value) -> HttpRequest {
    HttpRequest {
      url: "https://api.openai.com/v1/responses".into(),
      headers: vec![],
      body: HttpBody::Json(json!({"model":"discovered-model","input":input})),
      timeout_ms: None,
      egress_policy: llm_adapter::target::EgressPolicy::PublicOnly,
    }
  }
  fn completed(output: Value) -> String {
    format!(
      "data: {}\n\n",
      json!({"type":"response.completed","response":{"status":"completed","output":output}})
    )
  }
  #[test]
  fn multi_round_tools_replay_encrypted_reasoning_and_outputs() {
    let reasoning = json!({"type":"reasoning","id":"rs_1","encrypted_content":"opaque","summary":[]});
    let call = json!({"type":"function_call","call_id":"call_1","name":"read_doc","arguments":"{}"});
    let second_call = json!({"type":"function_call","call_id":"call_2","name":"edit_doc","arguments":"{}"});
    let client = client(vec![
      vec![completed(json!([reasoning, call]))],
      vec![completed(json!([second_call]))],
      vec![completed(json!([]))],
    ]);
    client
      .post_sse(request(json!([{"role":"user","content":"read and edit"}])), &mut |_| {
        Ok(())
      })
      .unwrap();
    client
      .post_sse(
        request(json!([{"type":"function_call_output","call_id":"call_1","output":"document"}])),
        &mut |_| Ok(()),
      )
      .unwrap();
    client.post_sse(request(json!([{"type":"function_call_output","call_id":"call_1","output":"document"},{"type":"function_call_output","call_id":"call_2","output":"edited"}])),&mut |_|Ok(())).unwrap();
    let requests = client.inner.requests.borrow();
    assert_eq!(requests.len(), 3);
    let history = requests[2]["input"].as_array().unwrap();
    assert_eq!(history.len(), 6);
    assert_eq!(history[1], reasoning);
    assert_eq!(history[2], call);
    assert_eq!(history[4], second_call);
    assert_eq!(history[5]["output"], "edited");
  }
  #[test]
  fn sparse_completion_replays_parallel_tools_using_item_ids() {
    use llm_adapter::{
      core::StreamEvent,
      stream::{OpenaiResponsesStreamParser, SseFrameDecoder},
    };

    let reasoning = json!({"type":"reasoning","id":"rs_1","encrypted_content":"opaque","summary":[]});
    let calls = [
      json!({"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_doc","arguments":"{\"doc\":\"A\"}"}),
      json!({"type":"function_call","id":"fc_2","call_id":"call_2","name":"read_doc","arguments":"{\"doc\":\"B\"}"}),
    ];
    let frame = |event: Value| format!("data: {event}\n\n");
    let mut frames = vec![frame(
      json!({"type":"response.output_item.done","output_index":0,"item":reasoning}),
    )];
    for (index, call) in calls.iter().enumerate() {
      let mut added = call.clone();
      added["arguments"] = json!("");
      frames.push(frame(
        json!({"type":"response.output_item.added","output_index":index+1,"item":added}),
      ));
    }
    // Argument streams may be interleaved and do not carry call_id or name.
    for call in &calls {
      frames.push(frame(
        json!({"type":"response.function_call_arguments.delta","item_id":call["id"],"delta":call["arguments"]}),
      ));
    }
    for (index, call) in calls.iter().enumerate() {
      frames.push(frame(
        json!({"type":"response.function_call_arguments.done","item_id":call["id"],"arguments":call["arguments"]}),
      ));
      frames.push(frame(
        json!({"type":"response.output_item.done","output_index":index+1,"item":call}),
      ));
    }
    frames.push(completed(json!([])));
    let client = client(vec![frames, vec![completed(json!([]))]]);
    let mut decoder = SseFrameDecoder::default();
    let mut parser = OpenaiResponsesStreamParser::default();
    let mut events = Vec::new();
    client
      .post_sse(
        request(json!([{"role":"user","content":"read A and B"}])),
        &mut |chunk| {
          for frame in decoder.push_chunk(chunk) {
            events.extend(parser.push_frame(frame).unwrap());
          }
          Ok(())
        },
      )
      .unwrap();
    events.extend(parser.finish());
    let executed = events
      .iter()
      .filter_map(|event| match event {
        StreamEvent::ToolCall { call_id, arguments, .. } => Some((call_id.as_str(), arguments.clone())),
        _ => None,
      })
      .collect::<Vec<_>>();
    assert_eq!(
      executed,
      vec![("call_1", json!({"doc":"A"})), ("call_2", json!({"doc":"B"}))]
    );
    client
      .post_sse(
        request(json!([
          {"type":"function_call_output","call_id":"call_1","output":"A"},
          {"type":"function_call_output","call_id":"call_2","output":"B"}
        ])),
        &mut |_| Ok(()),
      )
      .unwrap();
    let requests = client.inner.requests.borrow();
    let history = requests[1]["input"].as_array().unwrap();
    assert_eq!(history.len(), 6);
    assert_eq!(history[1], reasoning);
    assert_eq!(history[2], calls[0]);
    assert_eq!(history[3], calls[1]);
    assert_eq!(history[4]["call_id"], "call_1");
    assert_eq!(history[5]["call_id"], "call_2");
  }
  #[test]
  fn sparse_structured_completion_retains_text_and_still_requires_completion() {
    let item = json!({"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"{\"title\":\"ok\"}"}]});
    let done = format!(
      "data: {}\n\n",
      json!({"type":"response.output_item.done","output_index":0,"item":item})
    );
    let client = client(vec![vec![done.clone(), completed(json!([]))]]);
    let response = client.post_json(request(json!([]))).unwrap();
    assert_eq!(response.body["output"], json!([item]));
    let mut truncated = CompletionGuard::default();
    truncated.push(&done).unwrap();
    assert!(truncated.finish().is_err());
    let mut missing = CompletionGuard::default();
    missing
      .push(&format!(
        "data: {}\n\n",
        json!({"type":"response.output_item.done","output_index":1,"item":item})
      ))
      .unwrap();
    assert!(missing.push(&completed(json!([]))).is_err());
  }
  #[test]
  fn structured_and_attachment_requests_use_streamed_completion() {
    let client = client(vec![vec![completed(
      json!([{"type":"message","content":[{"type":"output_text","text":"{\"title\":\"ok\"}"}]}]),
    )]]);
    let input = json!([{"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,fixture"},{"type":"input_file","file_data":"data:application/pdf;base64,fixture","filename":"doc.pdf"}]}]);
    let result = client.post_json(request(input.clone())).unwrap();
    assert_eq!(result.body["output"][0]["content"][0]["text"], "{\"title\":\"ok\"}");
    assert_eq!(client.inner.requests.borrow()[0]["input"], input);
  }
  #[test]
  fn failures_truncation_and_cancellation_do_not_retry() {
    for terminal in ["response.failed", "response.incomplete", "error"] {
      let client = client(vec![vec![format!(
        "data: {}\n\n",
        json!({"type":terminal,"error":{"code":"subscription_sharing_usage_limit_exceeded"}})
      )]]);
      assert!(client.post_sse(request(json!([])), &mut |_| Ok(())).is_err());
      assert_eq!(client.inner.requests.borrow().len(), 1);
      assert!(client.replay.borrow().is_none());
    }
    let truncated = client(vec![vec![
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".into(),
    ]]);
    assert!(truncated.post_json(request(json!([]))).is_err());
    let cancelled = client(vec![vec![completed(json!([]))]]);
    assert!(
      cancelled
        .post_sse(request(json!([])), &mut |_| Err(failure("cancelled")))
        .is_err()
    );
    assert!(cancelled.replay.borrow().is_none());
    let wrong = client(vec![]);
    let mut req = request(json!([]));
    req.url = "https://example.test/responses".into();
    assert!(wrong.post_json(req).is_err());
    assert!(wrong.inner.requests.borrow().is_empty());
  }
  #[test]
  fn direct_route_contract_and_tools() {
    let mut body = json!({"store":true,"stream":false,"temperature":0.2,"previous_response_id":"old","input":[{"role":"system","content":"instructions"}],"tools":[{"type":"function","name":"read_doc"}]});
    normalize(&mut body).unwrap();
    assert_eq!(body["store"], false);
    assert_eq!(body["stream"], true);
    assert!(body.get("temperature").is_none());
    assert!(body.get("previous_response_id").is_none());
    assert_eq!(body["input"][0]["type"], "additional_tools");
    assert_eq!(body["input"][1]["role"], "developer");
    assert!(body.get("tools").is_none());
  }
  #[test]
  fn completion_is_required_and_split_frames_are_supported() {
    let mut parser = CompletionGuard::default();
    assert!(parser.push("data: {\"type\":\"response.com").unwrap().is_empty());
    parser.push("pleted\",\"response\":{\"output\":[]}}\r\n\r\n").unwrap();
    assert!(parser.finish().is_ok());
    assert!(CompletionGuard::default().finish().is_err());
    let mut parser = CompletionGuard::default();
    assert!(parser.push("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\"}}}\n\n").is_err());
  }
  #[test]
  fn hosted_tools_are_rejected() {
    assert!(normalize(&mut json!({"input":[],"tools":[{"type":"file_search"}]})).is_err());
  }
}
