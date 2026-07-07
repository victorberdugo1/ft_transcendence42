import { useState } from "react";

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function Register({ onLogin, onSwitchToLogin }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();

    const normalizedUsername = username.trim();
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedUsername || !normalizedEmail || !password || !confirmPassword) {
      setError("All fields are required.");
      return;
    }

    if (normalizedUsername.length < 3) {
      setError("Username must be at least 3 characters long.");
      return;
    }

    if (!isValidEmail(normalizedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        // The backend also creates the session on register.
        credentials: "include",
        body: JSON.stringify({
          username: normalizedUsername,
          email: normalizedEmail,
          password,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Register failed.");
        return;
      }

      onLogin(data.user);
    } catch (requestError) {
      console.error("[auth] register failed:", requestError);
      setError("Could not reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label className="auth-label" htmlFor="register-username">
        Username
      </label>
      <input
        id="register-username"
        className="auth-input"
        type="text"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        autoComplete="username"
        placeholder="Choose a username"
      />

      <label className="auth-label" htmlFor="register-email">
        Email
      </label>
      <input
        id="register-email"
        className="auth-input"
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="email"
        placeholder="you@example.com"
      />

      <label className="auth-label" htmlFor="register-password">
        Password
      </label>
      <div className="password-input-wrapper">
        <input
          id="register-password"
          className="auth-input"
          type={showPassword ? "text" : "password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          placeholder="At least 8 characters"
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setShowPassword(!showPassword)}
          tabIndex="-1"
        >
          {showPassword ? "👁️" : "👁️‍🗨️"}
        </button>
      </div>

      <label className="auth-label" htmlFor="register-confirm-password">
        Confirm password
      </label>
      <div className="password-input-wrapper">
        <input
          id="register-confirm-password"
          className="auth-input"
          type={showConfirmPassword ? "text" : "password"}
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          autoComplete="new-password"
          placeholder="Repeat your password"
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setShowConfirmPassword(!showConfirmPassword)}
          tabIndex="-1"
        >
          {showConfirmPassword ? "👁️" : "👁️‍🗨️"}
        </button>
      </div>

      {error ? <p className="auth-error">{error}</p> : null}

      <button className="auth-submit" type="submit" disabled={loading}>
        {loading ? "Creating account..." : "Create account"}
      </button>

      <p className="auth-switch">
        Already have an account?{" "}
        <button type="button" className="auth-link" onClick={onSwitchToLogin}>
          Sign in
        </button>
      </p>
    </form>
  );
}
