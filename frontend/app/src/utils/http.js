export async function apiFetchJson(url, options = {}) {
  const method = options.method || "GET";
  const body = options.body ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : null;

  const headers = {
    ...(body && { "Content-Type": "application/json" }),
    ...(options.headers || {}),
  };

  const fetchOptions = {
    method,
    credentials: "include",
    headers,
  };

  if (body) {
    fetchOptions.body = body;
  }

  const response = await fetch(url, fetchOptions);

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw {
      status: response.status,
      message: payload?.error || payload?.message || `HTTP ${response.status}`,
      data: payload,
    };
  }

  return payload;
}
