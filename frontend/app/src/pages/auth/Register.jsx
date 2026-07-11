import { apiFetchJson } from "@src/utils/http.js";
import { useState } from "react";
import { useTranslation } from "react-i18next";

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function Register({ onLogin, onSwitchToLogin }) {
  const { t } = useTranslation();
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
      setError(t("validation.allFieldsRequired"));
      return;
    }

    if (normalizedUsername.length < 3) {
      setError(t("validation.usernameMin"));
      return;
    }

    if (!isValidEmail(normalizedEmail)) {
      setError(t("validation.invalidEmail"));
      return;
    }

    if (password.length < 8) {
      setError(t("validation.passwordMin"));
      return;
    }

    if (password !== confirmPassword) {
      setError(t("validation.passwordMismatch"));
      return;
    }

    setError("");
    setLoading(true);

    try {
      const data = await apiFetchJson("/api/register", {
        method: "POST",
        body: {
          username: normalizedUsername,
          email: normalizedEmail,
          password,
        },
      });

      if (!data) {
        setError(data.error || t("validation.registerFailed"));
        return;
      }

      onLogin(data.user);
    } catch (requestError) {
      console.error("[auth] register failed:", requestError);
      setError(t("validation.serverUnreachable"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label className="auth-label" htmlFor="register-username">
        {t("auth.username")}
      </label>
      <input
        id="register-username"
        className="auth-input"
        type="text"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        autoComplete="username"
        placeholder={t("auth.usernamePlaceholder")}
      />

      <label className="auth-label" htmlFor="register-email">
        {t("auth.email")}
      </label>
      <input
        id="register-email"
        className="auth-input"
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="email"
        placeholder={t("auth.emailPlaceholder")}
      />

      <label className="auth-label" htmlFor="register-password">
        {t("auth.password")}
      </label>
      <div className="password-input-wrapper">
        <input
          id="register-password"
          className="auth-input"
          type={showPassword ? "text" : "password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          placeholder={t("auth.registerPasswordPlaceholder")}
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
        {t("auth.confirmPassword")}
      </label>
      <div className="password-input-wrapper">
        <input
          id="register-confirm-password"
          className="auth-input"
          type={showConfirmPassword ? "text" : "password"}
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          autoComplete="new-password"
          placeholder={t("auth.confirmPasswordPlaceholder")}
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
        {loading ? t("auth.creatingAccount") : t("auth.createAccount")}
      </button>

      <p className="auth-switch">
        {t("auth.haveAccount")} {" "}
        <button type="button" className="auth-link" onClick={onSwitchToLogin}>
          {t("auth.switchToSignIn")}
        </button>
      </p>
    </form>
  );
}
