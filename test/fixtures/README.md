# Test fixtures

## `pebble.minica.pem`

The root certificate of [pebble](https://github.com/letsencrypt/pebble), the
ACME test server the certificate tests run against.

**This is not a trust anchor.** It is a deliberately public test CA whose
private key is published in the pebble repository, and it is committed here
only so the ACME integration test can verify pebble's TLS without disabling
certificate verification — which would make the test prove nothing about the
code path that matters.

It is passed to the server under test as `ACME_CA_BUNDLE_FILE`, which is read
only when set. Production never sets it, and so uses the system trust store
and the real Let's Encrypt directory.

Note what this certificate does and does not sign. It signs **pebble's own
HTTPS listener**, which is what lets acme-client trust `https://pebble:14000`.
It does *not* sign the certificates pebble issues: those chain to a root
pebble generates fresh on every start and serves from its management API at
`/roots/0`. The test fetches that separately to verify the router's own
certificate, and the two must not be confused — using this file to verify an
issued certificate fails with an unknown-issuer error that looks like a bug
in the router.

Refresh it from
`https://raw.githubusercontent.com/letsencrypt/pebble/main/test/certs/pebble.minica.pem`
if pebble ever rotates it. The copy here is valid until 2125.
