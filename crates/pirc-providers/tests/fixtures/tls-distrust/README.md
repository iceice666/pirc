# TLS distrust regression fixtures

These are **public certificates only**, intentionally containing distrusted
intermediates and legacy trust anchors. They are test data, never a production
CA bundle. No compromised or control private keys are included.

The twelve `*-emudhra.we-have-a-problem.com.pem` files are the leaf-first
chains published by the incident reporter, captured on 2026-10-20. They cover
DV/OV/EV G3B/G3C through both the emSign chain and the AAA cross-sign:

- [Incident report](https://emudhra.we-have-a-problem.com/)
- [Public chain archive source](https://github.com/galadran/we-have-a-problem.com/blob/main/chains.zip)
- Archive SHA-256: `8a2edc81b6c51e3ad27d45ca1e441ec84c961e2dee0fc547f2a02c0f74315f95`.

The two legacy roots come from the report's public
[roots.json](https://github.com/galadran/we-have-a-problem.com/blob/main/roots.json):

| File                     | Certificate SHA-256                                                |
| ------------------------ | ------------------------------------------------------------------ |
| `aaa-root.pem`           | `D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4` |
| `emsign-ecc-root-g3.pem` | `86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B` |

The `control-*` certificates are a locally generated P-256 test root and
`localhost` server certificate with server-auth EKU. Their temporary private
keys were discarded after generation. They provide a positive control and
distinct wrong-host/unknown-issuer failures.

Verification time is frozen at **2026-10-22 12:00 UTC**, inside fixture validity,
so expiration can never masquerade as successful distrust enforcement. Every
incident chain must return `webpki::Error::CertDistrusted`, including on Linux's
platform-verifier path with the old root explicitly trusted. Tests are offline,
use no service credentials, and do not modify operating-system trust stores.

On Linux, the Rustls test uses `rustls-platform-verifier`, as the gateway and
node do. On macOS and Windows, it instead tests Rustls's WebPKI verifier with
explicit test roots; it does not establish that the native operating-system
trust service has received its distrust updates. Existing Linux CI also runs
this test through the workspace test suite.

```sh
cargo test --locked -p pirc-providers --test tls_distrust
```
