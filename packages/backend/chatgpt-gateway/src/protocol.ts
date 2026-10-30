import { randomUUID } from 'node:crypto';

import { OpenAI, RESOURCE } from './openai.ts';
import type { Json, Session } from './types.ts';
import { fail, GatewayError } from './util.ts';

const LIMIT = 16 * 1024 * 1024;
const omitted = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
];

export function normalize(request: Json, model: string): Json {
  const body = structuredClone(request);
  for (const key of omitted) delete body[key];
  body.model = model;
  body.store = false;
  body.stream = true;
  body.include = ['reasoning.encrypted_content'];
  if (typeof body.input === 'string')
    body.input = [{ role: 'user', content: body.input }];
  if (!Array.isArray(body.input))
    return fail('invalid_input', 'Responses input must be a string or array.');
  for (const item of body.input) {
    if (!item || typeof item !== 'object')
      return fail('invalid_input', 'Invalid input item.');
    if (item.role === 'system') item.role = 'developer';
    for (const part of Array.isArray(item.content) ? item.content : []) {
      // Attachments remain disabled until a real end-to-end model probe enables them.
      if (part.type && !['input_text', 'output_text'].includes(part.type)) {
        return fail(
          'unsupported_modality',
          'This gateway profile currently supports text input only.'
        );
      }
    }
  }
  if (body.tools !== undefined) {
    if (
      !Array.isArray(body.tools) ||
      body.tools.some((tool: Json) => tool.type !== 'function')
    ) {
      return fail('unsupported_tool', 'Only function tools are supported.');
    }
    if (body.tools.length)
      body.input.unshift({
        type: 'additional_tools',
        role: 'developer',
        tools: body.tools,
      });
    delete body.tools;
  }
  return body;
}

export class CompletionGuard {
  private buffer = '';
  private completed?: Json;
  private readonly items = new Map<number, Json>();
  private readonly calls = new Map<string, string>();
  push(chunk: string): Json[] {
    this.buffer += chunk.replaceAll('\r', '');
    if (Buffer.byteLength(this.buffer) > LIMIT)
      return fail(
        'invalid_stream',
        'Upstream event exceeds the size limit.',
        502
      );
    const events: Json[] = [];
    let boundary: number;
    while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      let event: Json;
      try {
        event = JSON.parse(data);
      } catch {
        return fail('invalid_stream', 'Malformed upstream event.', 502);
      }
      if (!event || typeof event !== 'object' || this.completed)
        return fail('invalid_stream', 'Unexpected upstream event.', 502);
      if (
        [
          'response.failed',
          'response.incomplete',
          'response.error',
          'error',
        ].includes(event.type)
      ) {
        return fail(
          'upstream_incomplete',
          'ChatGPT did not complete the response; check connection and usage settings.',
          502
        );
      }
      if (
        ['response.output_item.added', 'response.output_item.done'].includes(
          event.type
        )
      ) {
        const item = event.item;
        if (!item || typeof item !== 'object')
          return fail('invalid_stream', 'Missing output item.', 502);
        if (item.type === 'function_call') {
          if (typeof item.id !== 'string' || typeof item.call_id !== 'string')
            return fail('invalid_stream', 'Missing tool call identity.', 502);
          this.calls.set(item.id, item.call_id);
        }
        if (event.type === 'response.output_item.done') {
          const index = event.output_index;
          if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            this.items.has(index)
          )
            return fail('invalid_stream', 'Invalid output index.', 502);
          this.items.set(index, item);
        }
      }
      if (
        [
          'response.function_call_arguments.delta',
          'response.function_call_arguments.done',
        ].includes(event.type)
      ) {
        const callId = this.calls.get(event.item_id);
        if (!callId) return fail('invalid_stream', 'Unknown tool item.', 502);
        event.call_id = callId;
      }
      if (event.type === 'response.completed') {
        const response = event.response;
        if (
          !response ||
          response.status !== 'completed' ||
          !Array.isArray(response.output)
        ) {
          return fail('invalid_stream', 'Invalid completion event.', 502);
        }
        if (response.output.length === 0 && this.items.size) {
          const sorted = [...this.items.entries()].sort(([a], [b]) => a - b);
          if (sorted.some(([index], position) => index !== position))
            return fail(
              'invalid_stream',
              'Missing finalized output item.',
              502
            );
          response.output = sorted.map(([, item]) => item);
        }
        this.completed = response;
      }
      events.push(event);
    }
    return events;
  }
  finish(): Json {
    if (this.buffer.trim() || !this.completed)
      return fail(
        'truncated_stream',
        'ChatGPT stream ended before completion.',
        502
      );
    return this.completed;
  }
}

type Chain = {
  scope: string;
  history: Json[];
  pending: Map<string, string>;
  aliases: Set<string>;
  inFlight: boolean;
  expires: number;
};

// Conversation contents are memory-only, bounded, and never enter the credential store.
export class Continuations {
  private readonly calls = new Map<string, Chain>();
  private readonly chains = new Set<Chain>();
  constructor(
    private readonly ttl = 15 * 60_000,
    private readonly maxBytes = 64 * 1024 * 1024
  ) {}
  clear() {
    this.calls.clear();
    this.chains.clear();
  }
  private sweep() {
    for (const chain of this.chains) {
      if (!chain.inFlight && chain.expires < Date.now()) this.drop(chain);
    }
  }
  private drop(chain: Chain) {
    chain.aliases.forEach(id => this.calls.delete(id));
    this.chains.delete(chain);
  }
  begin(scope: string, input: Json[]) {
    this.sweep();
    const outputs = input.filter(item => item.type === 'function_call_output');
    if (!outputs.length) {
      if (input.some(item => item.type === 'function_call'))
        return fail(
          'missing_tool_results',
          'Tool calls require their results.'
        );
      return { input, chain: undefined as Chain | undefined };
    }
    const roots = new Set(outputs.map(item => this.calls.get(item.call_id)));
    if (roots.size !== 1 || roots.has(undefined))
      return fail(
        'continuation_expired',
        'Tool context is missing, mixed, or expired; start a new AI request.'
      );
    const chain = [...roots][0];
    if (!chain) return fail('continuation_expired', 'Tool context is missing.');
    if (chain.scope !== scope)
      return fail(
        'continuation_mismatch',
        'Tool context belongs to a different connection or model.'
      );
    if (
      input.some(
        item =>
          item.type === 'function_call' && !chain.aliases.has(item.call_id)
      )
    )
      return fail(
        'continuation_mismatch',
        'Tool calls belong to different conversation chains.'
      );
    if (chain.inFlight)
      return fail(
        'continuation_busy',
        'A continuation is already running.',
        409
      );
    const pending = outputs.filter(item => chain.pending.has(item.call_id));
    if (
      !pending.length ||
      pending.length !== chain.pending.size ||
      new Set(pending.map(item => item.call_id)).size !== pending.length
    ) {
      return fail(
        'missing_tool_results',
        'Every outstanding tool call must have exactly one result.'
      );
    }
    chain.inFlight = true;
    return {
      chain,
      input: [
        ...structuredClone(chain.history),
        ...pending.map(item => ({
          ...item,
          call_id: chain.pending.get(item.call_id),
        })),
      ],
    };
  }
  commit(
    scope: string,
    input: Json[],
    response: Json,
    aliases: Map<string, string>,
    old?: Chain
  ) {
    const calls: Json[] = response.output.filter(
      (item: Json) => item.type === 'function_call'
    );
    if (!calls.length) {
      if (old) this.drop(old);
      return;
    }
    const history = [...input, ...response.output];
    const bytes = Buffer.byteLength(JSON.stringify(history));
    if (bytes > this.maxBytes)
      return fail(
        'context_too_large',
        'Tool context exceeds the gateway memory limit.',
        413
      );
    this.sweep();
    let used = [...this.chains].reduce(
      (total, chain) =>
        total + Buffer.byteLength(JSON.stringify(chain.history)),
      0
    );
    for (const chain of this.chains) {
      if (used + bytes <= this.maxBytes && this.chains.size < 128) break;
      if (chain !== old && !chain.inFlight) {
        used -= Buffer.byteLength(JSON.stringify(chain.history));
        this.drop(chain);
      }
    }
    if (
      used -
        (old ? Buffer.byteLength(JSON.stringify(old.history)) : 0) +
        bytes >
        this.maxBytes ||
      (!old && this.chains.size >= 128)
    ) {
      return fail(
        'context_capacity',
        'Gateway tool context capacity is temporarily exhausted.',
        503
      );
    }
    const chain: Chain = old ?? {
      scope,
      history: [],
      pending: new Map(),
      aliases: new Set(),
      inFlight: false,
      expires: 0,
    };
    chain.history = history;
    chain.pending = new Map(
      calls.map(item => [
        aliases.get(item.call_id) ??
          fail('invalid_stream', 'Missing mapped tool identity.', 502),
        item.call_id,
      ])
    );
    chain.expires = Date.now() + this.ttl;
    chain.inFlight = false;
    for (const id of chain.pending.keys()) {
      if (!id)
        return fail('invalid_stream', 'Missing mapped tool identity.', 502);
      chain.aliases.add(id);
      this.calls.set(id, chain);
    }
    this.chains.add(chain);
  }
}

export class Responses {
  readonly continuations = new Continuations();
  constructor(private readonly upstream: OpenAI) {}

  async run(
    request: Json,
    session: Session,
    signal?: AbortSignal,
    emit?: (event: Json) => Promise<void>
  ) {
    if (request.model !== 'chatgpt-default')
      return fail('unknown_model', 'Use the chatgpt-default model alias.');
    const body = normalize(request, session.model);
    const { input, chain } = this.continuations.begin(
      session.scope,
      body.input
    );
    body.input = input;
    const aliases = new Map<string, string>();
    const alias = (id: string) => {
      let value = aliases.get(id);
      if (!value) {
        value = 'call_gw_' + randomUUID().replaceAll('-', '');
        aliases.set(id, value);
      }
      return value;
    };
    const external = (value: Json): Json => {
      const copy = structuredClone(value);
      const visit = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (typeof node.call_id === 'string')
          node.call_id = alias(node.call_id);
        if (node.model) node.model = 'chatgpt-default';
        // Never expose reasoning ciphertext. The gateway retains it for continuations.
        if (node.type === 'reasoning') delete node.encrypted_content;
        Object.values(node).forEach(visit);
      };
      visit(copy);
      return copy;
    };
    try {
      const response = await this.upstream.request(RESOURCE + '/responses', {
        method: 'POST',
        signal,
        headers: {
          Authorization: 'Bearer ' + session.accessToken,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok || !response.body)
        throw new GatewayError(
          'upstream_rejected',
          'ChatGPT rejected the response; check account and usage settings.',
          response.status === 429 ? 429 : response.status === 401 ? 401 : 502,
          response.headers.get('retry-after') ?? undefined
        );
      const guard = new CompletionGuard();
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        if (signal?.aborted)
          return fail('cancelled', 'Request cancelled.', 499);
        for (const event of guard.push(
          decoder.decode(chunk, { stream: true })
        )) {
          // Defer success until the upstream stream and context commit have both completed.
          if (event.type !== 'response.completed')
            await emit?.(external(event));
        }
      }
      guard.push(decoder.decode());
      const complete = guard.finish();
      for (const item of complete.output)
        if (item.type === 'function_call') alias(item.call_id);
      this.continuations.commit(
        session.scope,
        body.input,
        complete,
        aliases,
        chain
      );
      const result = external(complete);
      await emit?.({ type: 'response.completed', response: result });
      return result;
    } finally {
      if (chain) chain.inFlight = false;
    }
  }
}
