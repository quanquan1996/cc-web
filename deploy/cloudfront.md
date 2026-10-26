# CloudFront + origin protection checklist

TLS ends at CloudFront, using an ACM certificate. CloudFront then connects to the EC2 origin over plain HTTP on any port (default `8787`). The origin only accepts traffic that passes **both** checks below:

1. **Network check.** The security group admits only CloudFront's managed prefix list.
2. **Secret check.** Each request must carry the `X-Origin-Secret` header that only your distribution injects.

You need both. Every CloudFront customer shares the prefix list, so anyone with their own distribution can reach your origin through it. The secret header is the part only your distribution has.

```
browser ──HTTPS──▶ CloudFront (ACM cert, adds X-Origin-Secret) ──HTTP:8787──▶ EC2 (SG: CloudFront prefix list only)
```

---

## 0. Prerequisites

- [ ] `deploy/install.sh` has run and both services are healthy: `curl -s http://127.0.0.1:8787/healthz`.
- [ ] You have the origin secret: `sudo grep ^ORIGIN_SECRET= /etc/cc-web/env`.
- [ ] The EC2 instance has a public DNS name, e.g. `ec2-1-2-3-4.compute-1.amazonaws.com`. CloudFront custom origins need a DNS name, not a raw IP.

## 1. Certificate (ACM, **us-east-1** only)

CloudFront only accepts ACM certificates from **us-east-1 (N. Virginia)**, whatever region the EC2 instance is in.

- [ ] ACM console → switch region to **us-east-1** → *Request a public certificate*.
- [ ] Domain: `console.example.com`. You can also request a wildcard.
- [ ] Validation: **DNS**. Create the CNAME record ACM shows you (one click if the zone is in Route 53).
- [ ] Wait for status **Issued**.
- [ ] No domain yet? Skip this step and use the default `https://dxxxx.cloudfront.net` certificate.

## 2. Create the distribution: origin

CloudFront → *Create distribution*:

- [ ] **Origin domain**: the EC2 **public DNS name**. Type it in; it will not be listed.
- [ ] **Protocol**: *HTTP only*. CloudFront → EC2 is plain HTTP, and the backend has no certificate.
- [ ] **HTTP port**: `8787` (your `PORT_CORE`). CloudFront allows custom ports 80, 443 and 1024–65535.
- [ ] **Add custom header**:
  - Name: `X-Origin-Secret`
  - Value: the `ORIGIN_SECRET` value from `/etc/cc-web/env`
- [ ] **Origin Shield**: off.
- [ ] *Additional settings*: **response timeout 60 s** (the maximum without a quota increase) and **keep-alive timeout 60 s**.

## 3. Default behavior (`*`): static console files

- [ ] Viewer protocol policy: **Redirect HTTP to HTTPS**.
- [ ] Allowed methods: **GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE**. Generated dynamic apps under `/apps/*` may need them.
- [ ] Cache policy: **CachingDisabled**. This is the simple, safe choice: the HTML is tiny, and `/apps/*` sits behind auth. If you want caching for `/`, `/app.js` and `/style.css`, add separate behaviors with *CachingOptimized*.
- [ ] Origin request policy: **AllViewer**. It forwards the cookie, which `/apps/*` needs for auth.
- [ ] Compression: on.

## 4. Behaviors for `/api/*`, `/ws/*` and `/apps/*`

Create one behavior per path pattern. Use **identical settings** for all three:

| Setting | Value |
|---|---|
| Path pattern | `/api/*`, then `/ws/*`, then `/apps/*` |
| Origin | the EC2 origin |
| Viewer protocol policy | Redirect HTTP to HTTPS (or HTTPS only) |
| Allowed methods | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE |
| Cache policy | **Managed-CachingDisabled** |
| Origin request policy | **Managed-AllViewer** (forwards all headers, cookies, query strings) |

- [ ] WebSocket: CloudFront supports WebSocket natively. `/ws/*` **must** use AllViewer so the `Upgrade`, `Connection`, `Sec-WebSocket-*`, `Cookie` and `Origin` headers reach the origin. Without them, streaming breaks.
- [ ] Keepalive: the server pings every 20 s, which keeps CloudFront's idle timeout from closing long runs.
- [ ] `AllViewer` forwards the viewer `Host` header. The backend uses it for its CSRF/Origin check. Do **not** swap in a policy that rewrites `Host` unless you also forward `X-Forwarded-Host`.

## 5. Distribution settings

- [ ] **Alternate domain name (CNAME)**: `console.example.com`, and pick the ACM certificate from step 1.
- [ ] Security policy: **TLSv1.2_2021** or newer.
- [ ] HTTP versions: HTTP/2 and HTTP/3.
- [ ] IPv6: optional.
- [ ] Default root object: leave empty. The backend serves `/`.
- [ ] Create the distribution. Then point DNS at it: a Route 53 alias, or a CNAME to `dxxxx.cloudfront.net`.

## 6. Security group (EC2): CloudFront prefix list only

- [ ] VPC console → *Managed prefix lists* → find **`com.amazonaws.global.cloudfront.origin-facing`** and note its id (`pl-xxxxxxxx`).
- [ ] EC2 → instance security group → *Inbound rules*:
  - **Remove** every rule for port 8787 with source `0.0.0.0/0` or `::/0`.
  - **Add**: Custom TCP, port `8787`, Source = **prefix list** `com.amazonaws.global.cloudfront.origin-facing`.
- [ ] That prefix list has a large weight: it counts as many rules against the security-group rule quota. If you hit the limit, ask for a quota increase or use a dedicated security group for this rule.
- [ ] Keep SSH (22) limited to your own IP, or use SSM Session Manager and close 22 entirely.
- [ ] Port `8788` (apps) is bound to `127.0.0.1` and must **never** be opened.

CLI equivalent:

```bash
PL=$(aws ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text)
aws ec2 authorize-security-group-ingress --group-id sg-XXXXXXXX \
  --ip-permissions "IpProtocol=tcp,FromPort=8787,ToPort=8787,PrefixListIds=[{PrefixListId=$PL,Description=CloudFront}]"
```

## 7. Verify

- [ ] `curl -i https://console.example.com/healthz` returns `200`.
- [ ] `curl -i https://console.example.com/api/me` returns `401`: it went through CloudFront, so the header check passed.
- [ ] From your laptop, `curl -i http://<ec2-public-dns>:8787/api/me` **times out** (blocked by the security group).
- [ ] On the instance, `curl -i http://127.0.0.1:8787/api/me` returns `403` (no origin secret). This proves the header check is on.
- [ ] Log in through the browser, run a prompt and watch it stream. Then try a run longer than 60 s and confirm it is not cut off.
- [ ] `/apps/` loads when logged in and redirects to the login page in a private window.

## 8. Rotating the origin secret

1. Generate a new value: `openssl rand -hex 32`.
2. Update `/etc/cc-web/env`, and in the same few minutes the CloudFront origin custom header. Wait for the distribution to finish deploying.
3. Restart core: `sudo systemctl restart cc-web-core`. Requests carrying the old header get 403 from then on.

## 9. Optional hardening

- [ ] **AWS WAF** on the distribution: rate-based rule (e.g. 300 req / 5 min / IP), geo match allow-list, *AWSManagedRulesCommonRuleSet* and *AmazonIpReputationList*. This is cheap and worth it for a single-user site.
- [ ] **CloudFront Functions / Lambda@Edge** basic auth in front of everything, so unauthenticated traffic never reaches EC2.
- [ ] Turn on CloudFront standard logs or real-time logs.
