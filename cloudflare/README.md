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
2. Choose **Workers & Pages**, then **Create**, then **Create Worker** (the "Hello World" starter).
3. Name the Worker `edla-ask` and choose **Deploy**.
4. Choose **Edit code**. Delete the starter code, paste the whole of `cloudflare/ask-worker.js`, and choose **Deploy**.
5. Back on the Worker's page, choose **Settings**, then **Variables and Secrets**, then **Add**:
   - Type: **Secret**
   - Name: `GROQ_API_KEY`
   - Value: the Groq key from step 1
   Choose **Deploy**.
6. Copy the Worker's address from its page. The address looks like `https://edla-ask.<your-name>.workers.dev`.

### 3. Connect the site
Put the Worker's address in `ASK_URL` near the top of the Ask block in `assets/app.js` (search for `ASK_URL`), bump
the `?v=` stamp, and push. The **Ask** button then appears in the site's header. The address is not a secret.

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
