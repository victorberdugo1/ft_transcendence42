import { useState } from "react";

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function Login({ onLogin, onSwitchToRegister }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();

    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail || !password) {
      setError("Email and password are required.");
      return;
    }

    if (!isValidEmail(normalizedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        // This lets the browser store and send the session cookie.
        credentials: "include",
        body: JSON.stringify({
          email: normalizedEmail,
          password,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Login failed.");
        return;
      }

      onLogin(data.user);
    } catch (requestError) {
      console.error("[auth] login failed:", requestError);
      setError("Could not reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label className="auth-label" htmlFor="login-email">
        Email
      </label>
      <input
        id="login-email"
        className="auth-input"
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="email"
        placeholder="you@example.com"
      />

      <label className="auth-label" htmlFor="login-password">
        Password
      </label>
      <input
        id="login-password"
        className="auth-input"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="current-password"
        placeholder="Your password"
      />

      {error ? <p className="auth-error">{error}</p> : null}

      <button className="auth-submit" type="submit" disabled={loading}>
        {loading ? "Signing in..." : "Sign in"}
      </button>

      <p className="auth-switch">
        Need an account?{" "}
        <button type="button" className="auth-link" onClick={onSwitchToRegister}>
          Create one
        </button>
      </p>
    </form>
  );
}
