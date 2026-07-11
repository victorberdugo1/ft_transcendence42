import { useCallback, useEffect, useState } from "react";

export function useApiRequest(requestFn, dependencies = [], options = {}) {
  const { immediate = true, initialData = null, defaultError = "Request failed" } = options;
  const [status, setStatus] = useState(immediate ? "loading" : "idle");
  const [error, setError] = useState("");
  const [data, setData] = useState(initialData);

  const run = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const result = await requestFn();
      setData(result);
      setStatus("success");
      return result;
    } catch (requestError) {
      setStatus("error");
      setError(requestError?.message || defaultError);
      throw requestError;
    }
  }, [defaultError, requestFn]);

  useEffect(() => {
    if (!immediate) return undefined;
    let cancelled = false;

    setStatus("loading");
    setError("");

    requestFn()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setStatus("success");
      })
      .catch((requestError) => {
        if (cancelled) return;
        setStatus("error");
        setError(requestError?.message || defaultError);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [immediate, defaultError, ...dependencies]);

  return { status, error, data, setData, run };
}
