import { describe, expect, it } from 'bun:test';
import { oauthWorkerEnv } from '../src/backends/oauth-worker.js';
import { allowedEnvName, withoutSecrets } from '../src/node/secrets.js';

describe('agent environment (allowlist)', () => {
  it('drops the node secrets, credentials and everything not allowlisted', () => {
    expect(
      withoutSecrets({
        PIRC_NODE_TOKEN: 'a',
        PIRC_NODE_TOKENS: '{}',
        PIRC_OAUTH_SECRET_KEY: 'b',
        PIRC_CLIPROXYAPI_KEY: 'provider key in a shared environment file',
        PIRC_VAPID_PRIVATE_KEY: 'c',
        PIRC_PROXY_SECRET: 'p',
        EXA_API_KEY: 'd',
        ANTHROPIC_API_KEY: 'e',
        OPENAI_API_KEY: 'f',
        GITHUB_TOKEN: 'g',
        GH_TOKEN: 'h',
        NPM_TOKEN: 'i',
        AWS_SECRET_ACCESS_KEY: 'j',
        AWS_ACCESS_KEY_ID: 'k',
        AWS_PROFILE: 'l',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        GIT_SSH_COMMAND: 'ssh -i key',
        GIT_CONFIG_PARAMETERS: "'core.hooksPath=x'",
        HTTPS_PROXY: 'http://user:pass@proxy:3128',
        http_proxy: 'http://proxy',
        NODE_OPTIONS: '--require evil.js',
        LD_PRELOAD: '/tmp/x.so',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        XDG_CONFIG_TOKEN: 'never, whatever the prefix',
        PIRC_NODE_ID: 'n',
        PIRC_WORKSPACE_KIND: 'directory',
        PIRC_CONFIG_DIR: '/home/u/.config/.pirc',
        HOME: '/home/u',
        PATH: '/usr/bin:/bin',
        USER: 'u',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'iTerm.app',
        TMPDIR: '/tmp/u',
        XDG_RUNTIME_DIR: '/run/user/1000',
        NIX_SSL_CERT_FILE: '/etc/ssl/certs/ca-bundle.crt',
        LOCALE_ARCHIVE: '/run/current-system/sw/lib/locale/locale-archive',
        __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
        CLAUDE_CODE_TMPDIR: '/tmp/srt',
        EDITOR: 'vim',
      }),
    ).toEqual({
      PIRC_NODE_ID: 'n',
      PIRC_WORKSPACE_KIND: 'directory',
      PIRC_CONFIG_DIR: '/home/u/.config/.pirc',
      HOME: '/home/u',
      PATH: '/usr/bin:/bin',
      USER: 'u',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'iTerm.app',
      TMPDIR: '/tmp/u',
      XDG_RUNTIME_DIR: '/run/user/1000',
      NIX_SSL_CERT_FILE: '/etc/ssl/certs/ca-bundle.crt',
      LOCALE_ARCHIVE: '/run/current-system/sw/lib/locale/locale-archive',
      __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
      CLAUDE_CODE_TMPDIR: '/tmp/srt',
      EDITOR: 'vim',
    });
  });

  it('keeps extra names a caller asks for, but never pirc secrets', () => {
    expect(
      withoutSecrets({ SSH_AUTH_SOCK: '/s', PIRC_NODE_TOKEN: 't', HOME: '/h' }, [
        'SSH_AUTH_SOCK',
        'PIRC_NODE_TOKEN',
      ]),
    ).toEqual({ SSH_AUTH_SOCK: '/s', HOME: '/h' });
  });

  it('passes on what the operator names in PIRC_AGENT_ENV_ALLOW', () => {
    expect(
      withoutSecrets({
        PIRC_AGENT_ENV_ALLOW: ' GITHUB_TOKEN, NPM_TOKEN ,PIRC_NODE_TOKEN,bad-name',
        GITHUB_TOKEN: 'g',
        NPM_TOKEN: 'n',
        GH_TOKEN: 'not named',
        PIRC_NODE_TOKEN: 'never',
      }),
    ).toEqual({
      PIRC_AGENT_ENV_ALLOW: ' GITHUB_TOKEN, NPM_TOKEN ,PIRC_NODE_TOKEN,bad-name',
      GITHUB_TOKEN: 'g',
      NPM_TOKEN: 'n',
    });
    // The gateway's OAuth worker ignores it.
    expect(
      oauthWorkerEnv({ PIRC_AGENT_ENV_ALLOW: 'GITHUB_TOKEN', GITHUB_TOKEN: 'g' }).GITHUB_TOKEN,
    ).toBeUndefined();
  });

  it('treats credential-looking PIRC_ names as secret', () => {
    expect(allowedEnvName('PIRC_SANDBOX_POLICY')).toBe(true);
    expect(allowedEnvName('PIRC_NODE_TOKEN')).toBe(false);
    expect(allowedEnvName('PIRC_SOMETHING_PASSWORD')).toBe(false);
    expect(allowedEnvName('PIRC_UPSTREAM_CREDENTIALS')).toBe(false);
  });

  it('gives the OAuth worker only what it needs', () => {
    const env = oauthWorkerEnv({
      PATH: '/bin',
      HOME: '/h',
      HTTPS_PROXY: 'http://proxy:3128',
      PIRC_NODE_TOKENS: '{}',
      PIRC_VAPID_PRIVATE_KEY: 'v',
      EXA_API_KEY: 'x',
      ANTHROPIC_API_KEY: 'a',
    });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      HTTPS_PROXY: 'http://proxy:3128',
      PI_OAUTH_CALLBACK_HOST: '127.0.0.1',
    });
  });
});
