# Deploying Axiom at `axiom.yomexa.xyz`

The initial production POC is packaged as one Docker service containing the public Node server, private loopback-only chemistry service, and campaign worker. Co-location preserves the existing content-addressed artifact flow. Supabase remains the authoritative database, authentication, vector search, and object-storage plane.

## 1. Create the Render service

1. Sign in to Render and create a Blueprint from the GitHub repository.
2. Render will detect `render.yaml` and build `deploy/Dockerfile`.
3. Supply these secret values when prompted:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
4. Use a paid instance with sufficient memory for PyTorch, RDKit, and ADMET-AI. Do not use a sleeping/free web instance for campaign execution.
5. Wait for `/api/health` to pass. The first image build is large because it pins the scientific Python stack.

Render supports Docker web services, custom domains, managed TLS, health checks, persistent disks, and background processes. See the official [web-service](https://render.com/docs/web-services), [Docker](https://render.com/docs/docker), and [custom-domain](https://render.com/docs/custom-domains) documentation.

## 2. Point GoDaddy DNS to Render

After Render creates the service, its dashboard will show a hostname such as `axiom-observatory.onrender.com` and the exact verification target.

In GoDaddy:

1. Open **My Products → yomexa.xyz → DNS → Manage DNS**.
2. Remove any existing `A`, `AAAA`, or `CNAME` record whose host is `axiom`.
3. Add a record:
   - Type: `CNAME`
   - Name/Host: `axiom`
   - Value/Points to: the exact Render hostname
   - TTL: 600 seconds or GoDaddy's default
4. Return to Render and click **Verify** for `axiom.yomexa.xyz`.
5. Wait for Render to issue TLS, then verify `https://axiom.yomexa.xyz/api/health`.

The domain stays registered at GoDaddy; no transfer is needed.

## 3. Update Supabase Auth

In **Supabase Dashboard → Authentication → URL Configuration**:

- Site URL: `https://axiom.yomexa.xyz`
- Add redirect URL: `https://axiom.yomexa.xyz/auth/callback`
- Add redirect URL: `https://axiom.yomexa.xyz/reset-password`
- Keep the four existing localhost/127.0.0.1 development redirects.

For Google OAuth, retain the Supabase callback URI in Google Cloud and add `https://axiom.yomexa.xyz` as an authorized JavaScript origin if it is not already present.

## 4. Production boundary

The deployment exposes authenticated RDKit and ADMET-AI operations. Vina, prepared receptor files, calibrated applicability registries, AiZynthFinder policies/stocks, and clinical simulation engines remain unavailable until their real assets are installed and validated. Public chemistry execution is authenticated through Supabase; only the health endpoint is anonymous.
