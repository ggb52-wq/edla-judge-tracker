# The "Ask" relay

The site's **Ask** panel sends a reader's question to a small Cloudflare Worker (`ask-worker.js`). The Worker
asks an open-source model on Groq's free tier to turn the question into a query: the kind of motion, the judge, the
type of case, the period. The site then computes every figure from its own data and writes every sentence. The
model never states a number and never describes a judge.

The Worker holds the Groq key, so the key never appears in the web page. Both services are free at this site's
traffic; neither account needs a credit card.

## Setup (about ten minutes, once)

### 1. Groq key
1. Open https://console.groq.com and sign up (email or Google).
2. Choose **API Keys**, then **Create API Key**. Name the key `edla-ask`.
3. Copy the key. Groq shows the key once. Keep the key out of email, chat, and the repository.

### 2. Cloudflare Worker
1. Open https://dash.cloudflare.com and sign up.
2. Open **Workers & Pages** (on some accounts under **Compute** or **Build**), choose **Create application**, then
   **Start with Hello World!** (or **Create Worker**).
3. Name the Worker `edla-ask` and choose **Deploy**. A new account is asked to pick a `workers.dev` subdomain first.
4. Choose **Edit code**. Delete the starter code, paste the whole of `cloudflare/ask-worker.js`, and choose **Deploy**.
5. Back on the Worker's page, choose **Settings**, then **Variables and Secrets**, then **Add**. In the "Add
   environment variable" box: leave **Production** checked, Key `GROQ_API_KEY`, Value the Groq key from step 1, check
   **Secret**, then **Add variable and deploy**.
6. Copy the Worker's address from its page. The address looks like `https://edla-ask.<your-name>.workers.dev`.

### 3. Connect the site
`ASK_URL` in `assets/app.js` holds the Worker's address (set Nov. 12, 2026 to
`https://edla-ask.grantbutler52.workers.dev/`). A new Worker at a new address needs that line changed, the `?v=`
stamp bumped, and a push. The address is not a secret.

### Updating the Worker
After a change to `ask-worker.js`, open the Worker, choose **Edit code**, paste the whole file again, and choose
**Deploy**. The secret stays in place.

## Optional settings (Worker > Settings > Variables and Secrets, type Text)
- `MODELS`: Groq model names to try in order, separated by commas. Default:
  `openai/gpt-oss-120b,llama-3.3-70b-versatile,openai/gpt-oss-20b,llama-3.1-8b-instant`. Groq retires models from
  time to time; the Worker moves to the next name when one fails.
- `ORIGINS`: the sites allowed to call the Worker. Default: `https://ggb52-wq.github.io`, plus
  `http://localhost:8000` for local testing.

## Limits
Groq's free tier caps requests per minute and per day for the whole account; the panel says so when the cap is
reached. The Worker refuses calls from other websites. The Worker passes on only the reader's question and the
date; the site sends nothing else.
