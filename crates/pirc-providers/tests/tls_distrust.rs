//! RUSTSEC-2026-0382: reject compromised emSign keys even when a trust store
//! still accepts their roots. Public fixtures only; no network or OS CA edits.

use std::time::Duration;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};

// Freeze validation inside every fixture's validity period: expiration is not
// evidence that the compromised key was rejected (2026-10-22 12:00:00 UTC).
fn validation_time() -> UnixTime {
    UnixTime::since_unix_epoch(Duration::from_secs(1_792_670_400))
}

struct Case {
    name: &'static str,
    chain: &'static [u8],
    root: &'static [u8],
}

macro_rules! case {
    ($name:literal, $root:literal) => {
        Case {
            name: concat!($name, ".we-have-a-problem.com"),
            chain: include_bytes!(concat!(
                "fixtures/tls-distrust/",
                $name,
                ".we-have-a-problem.com.pem"
            )),
            root: include_bytes!(concat!("fixtures/tls-distrust/", $root, ".pem")),
        }
    };
}

const CASES: &[Case] = &[
    case!("dv-g3b-emudhra", "emsign-ecc-root-g3"),
    case!("dv-g3c-emudhra", "emsign-ecc-root-g3"),
    case!("ev-g3b-emudhra", "emsign-ecc-root-g3"),
    case!("ev-g3c-emudhra", "emsign-ecc-root-g3"),
    case!("ov-g3b-emudhra", "emsign-ecc-root-g3"),
    case!("ov-g3c-emudhra", "emsign-ecc-root-g3"),
    case!("dv-g3b-aaa-emudhra", "aaa-root"),
    case!("dv-g3c-aaa-emudhra", "aaa-root"),
    case!("ev-g3b-aaa-emudhra", "aaa-root"),
    case!("ev-g3c-aaa-emudhra", "aaa-root"),
    case!("ov-g3b-aaa-emudhra", "aaa-root"),
    case!("ov-g3c-aaa-emudhra", "aaa-root"),
];

const CONTROL_ROOT: &[u8] = include_bytes!("fixtures/tls-distrust/control-root.pem");
const CONTROL_LEAF: &[u8] = include_bytes!("fixtures/tls-distrust/control-leaf.pem");

fn certificates(pem: &[u8]) -> Vec<CertificateDer<'static>> {
    CertificateDer::pem_slice_iter(pem)
        .collect::<Result<_, _>>()
        .expect("valid public certificate fixture")
}

fn verify(chain: &[u8], root: &[u8], name: &str) -> Result<(), webpki::Error> {
    let chain = certificates(chain);
    let root = certificates(root);
    let anchors = root
        .iter()
        .map(|cert| webpki::anchor_from_trusted_cert(cert).unwrap())
        .collect::<Vec<_>>();
    let leaf = webpki::EndEntityCert::try_from(&chain[0]).unwrap();
    leaf.verify_is_valid_for_subject_name(&ServerName::try_from(name).unwrap())?;
    leaf.verify_for_usage(
        webpki::ALL_VERIFICATION_ALGS,
        &anchors,
        &chain[1..],
        validation_time(),
        webpki::KeyUsage::server_auth(),
        None,
        None,
    )
    .map(|_| ())
}

#[test]
fn rejects_compromised_keys_through_both_emsign_and_aaa_paths() {
    assert_eq!(CASES.len(), 12);
    for case in CASES {
        assert_eq!(
            verify(case.chain, case.root, case.name),
            Err(webpki::Error::CertDistrusted),
            "{} must fail because of the distrusted key, not expiry/name/issuer",
            case.name,
        );
    }
}

#[test]
fn valid_control_still_verifies_and_other_failures_are_distinguished() {
    assert_eq!(verify(CONTROL_LEAF, CONTROL_ROOT, "localhost"), Ok(()));
    assert_eq!(
        verify(CONTROL_LEAF, CASES[0].root, "localhost"),
        Err(webpki::Error::UnknownIssuer),
    );
    assert!(matches!(
        verify(CONTROL_LEAF, CONTROL_ROOT, "wrong.example"),
        Err(webpki::Error::CertNotValidForName(_)),
    ));
}

// Linux exercises the platform verifier used by reqwest and Node WSS. Other
// desktop hosts exercise rustls's equivalent WebPKI backend offline; this is
// deliberately not a test of macOS/Windows' live OS distrust updates.
// Explicit fixture roots model a still-trusting bundle without OS CA edits.
#[cfg(any(target_os = "linux", target_vendor = "apple", target_os = "windows"))]
#[test]
fn rustls_rejects_the_keys_even_with_trusted_fixture_roots() {
    use rustls::client::danger::ServerCertVerifier;
    use rustls::{CertificateError, Error};
    use std::sync::Arc;

    fn verifier(root: &[u8]) -> Arc<dyn ServerCertVerifier> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        if cfg!(target_os = "linux") {
            Arc::new(
                rustls_platform_verifier::Verifier::new_with_extra_roots(
                    certificates(root),
                    provider,
                )
                .unwrap(),
            )
        } else {
            let mut roots = rustls::RootCertStore::empty();
            for cert in certificates(root) {
                roots.add(cert).unwrap();
            }
            rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider)
                .build()
                .unwrap()
        }
    }

    for case in CASES {
        let chain = certificates(case.chain);
        let error = verifier(case.root)
            .verify_server_cert(
                &chain[0],
                &chain[1..],
                &ServerName::try_from(case.name).unwrap(),
                &[],
                validation_time(),
            )
            .expect_err("compromised key must be rejected even if its root is trusted");
        match error {
            Error::InvalidCertificate(CertificateError::Other(error)) => {
                assert_eq!(
                    error.0.downcast_ref::<webpki::Error>(),
                    Some(&webpki::Error::CertDistrusted),
                    "{}",
                    case.name
                );
            }
            error => panic!("{}: unexpected rejection cause: {error:?}", case.name),
        }
    }

    let control = certificates(CONTROL_LEAF);
    verifier(CONTROL_ROOT)
        .verify_server_cert(
            &control[0],
            &[],
            &ServerName::try_from("localhost").unwrap(),
            &[],
            validation_time(),
        )
        .expect("valid custom CA remains supported");
}
