# Model backends

[User guides](README.md) · [All documentation](../README.md)

- **Models (gateway)**: model backends and their credentials live only on the gateway, which also **runs every model request**. Agents stay on their nodes and send requests over the node link (via a private, token-protected Unix socket from agent to node); the gateway resolves the backend, calls the model, and streams the reply back. Nodes and agents receive only a secret-free model catalog: no API key, OAuth token, endpoint URL or header. Because credentials are resolved per request, a changed key, a token refresh, a new login or a logout reaches running sessions on their next request; a settings change cancels requests in flight. Backends come from two sources:
  - **Web Settings → Model backends** (`$PIRC_STATE_DIR/backends/settings.json`, mode 0600, written atomically): every subscription login built into the pinned [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai) version (`@mariozechner/pi-ai@0.73.1`: **Anthropic Claude Pro/Max**, **GitHub Copilot**, **ChatGPT Plus/Pro (Codex)**), API-key or keyless custom endpoints (`openai-completions`, `openai-responses`, `anthropic-messages`, legacy `openai-chat`), and the default model. See [Subscription logins](./model-backends.md#subscription-logins).
  - **`models.json`** (`PIRC_MODELS_FILE`, default `$PIRC_CONFIG_DIR/models.json`, i.e. `~/.config/.pirc/models.json`): `providers` and `defaultModel`, read-only in the web UI. Reference API keys with `apiKeyEnv`, `apiKeyFile`, or `apiKeyCommand` (resolved on the gateway). A file backend wins over a web backend with the same ID; the web default model wins over the file default. Send the gateway `SIGHUP` to reload the file. An invalid file is fatal at startup, and on reload it is logged and ignored.

  Endpoints must be reachable from the gateway (a model server that only listens on a node's `localhost` is not). Nodes have no provider settings of their own; `providers` and `defaultModel` in a node's `config.json` are ignored with a warning.

## Subscription logins

Open **Settings → Model backends** and choose **Log in**. The gateway runs pi-ai's login flow in an isolated, time-limited subprocess and shows its steps in the browser: the authorization link and instructions, device codes, questions (such as a GitHub Enterprise domain), and progress. Nothing needs a CLI on a node.

- **Claude Pro/Max** and **ChatGPT/Codex** use fixed `localhost` redirect URLs. When your browser is not on the gateway machine, the final redirect page fails to load; copy that complete `http://localhost:…` URL from the address bar and paste it into the login card. It must carry the state from this login. Do not expose a callback port.
- **GitHub Copilot** uses a device code. pi-ai's login also **enables the policy for every GitHub Copilot model it knows** on your account, so the UI requires explicit consent first. Some models may still need enabling in Copilot itself.
- Tokens are refreshed on the gateway shortly before they expire, once for concurrent requests. **Log out** deletes the gateway's saved credentials and blocks new requests; it does not revoke the account upstream or recall content already sent.
- pi-ai's model catalog is not proof that your plan includes a model, and a built-in login is not a statement about each service's terms for third-party clients: check them yourself. Real logins and paid calls are not part of the automated tests.

Chat projects (the assistant's chats on the chat node) can turn off delegation, memory search, remote recall, schedules and web search per project, and can carry instructions for every new chat. See [Chat projects](chat-projects.md).

Implementation references: [observational memory](../architecture/observational-memory.md) and [model backends and authentication](../architecture/backend-auth.md).
