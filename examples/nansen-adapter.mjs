const NANSEN_API_BASE = "https://api.nansen.ai";

/**
 * Make one explicit read-only example request. Importing this module performs
 * no network activity. The caller supplies the route and body and must provide
 * its own key outside the repository.
 */
export async function requestNansenExample(path, body, {
  apiKey = process.env.NANSEN_API_KEY,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) {
    throw new Error("Set NANSEN_API_KEY in the process environment before calling this example.");
  }

  const url = new URL(path, NANSEN_API_BASE);
  if (url.origin !== NANSEN_API_BASE) {
    throw new Error("The example only accepts Nansen API paths.");
  }

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Nansen example request failed with HTTP ${response.status}.`);
  }

  return response.json();
}