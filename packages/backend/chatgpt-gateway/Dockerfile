FROM node:22.23.2-bookworm-slim
WORKDIR /app
RUN mkdir -p /data /keys /run/gateway && chown node:node /data /keys /run/gateway
COPY dist/server.mjs dist/control.mjs ./
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
