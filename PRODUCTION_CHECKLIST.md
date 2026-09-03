# Production Checklist

- [ ] Replace all default secrets and passwords.
- [ ] PostgreSQL private network + backups + restore drill.
- [ ] Redis authentication/private network.
- [ ] S3/R2 private bucket; no public object ACLs.
- [ ] CDN/WAF in front of Nginx/API.
- [ ] TLS 1.2/1.3, HSTS after HTTPS verification.
- [ ] HLS/DASH packaging and real DRM license server.
- [ ] Video transcoding queue and background workers.
- [ ] PDF malware/type validation and page-count/size limits.
- [ ] Rate limits per IP + account + endpoint.
- [ ] Audit retention and immutable export.
- [ ] Monitoring, alerting, logs, backups, restore test.
- [ ] Load test >=500 concurrent users.
- [ ] OWASP ASVS/API security review and penetration test.
- [ ] Browser/device compatibility matrix.
- [ ] Privacy policy, deletion/export workflow, retention policy.
- [ ] Email/WhatsApp provider configuration.
