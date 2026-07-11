import { useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFetchJson } from "@src/utils/http.js";

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function Login({ onLogin, onSwitchToRegister }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();

    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail || !password) {
      setError(t("validation.emailPasswordRequired"));
      return;
    }

    if (!isValidEmail(normalizedEmail)) {
      setError(t("validation.invalidEmail"));
      return;
    }

    setError("");
    setLoading(true);

    try {
      const data = await apiFetchJson("/api/login", {
        method: "POST",
        body: {
          email: normalizedEmail,
          password,
        },
      });

      if (!data) {
        setError(data.error || t("validation.loginFailed"));
        return;
      }

      onLogin(data.user);
    } catch (requestError) {
      console.error("[auth] login failed:", requestError);
      setError(t("validation.serverUnreachable"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label className="auth-label" htmlFor="login-email">
        {t("auth.email")}
      </label>
      <input
        id="login-email"
        className="auth-input"
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="email"
        placeholder={t("auth.emailPlaceholder")}
      />

      <label className="auth-label" htmlFor="login-password">
        {t("auth.password")}
      </label>
      <div className="password-input-wrapper">
        <input
          id="login-password"
          className="auth-input"
          type={showPassword ? "text" : "password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          placeholder={t("auth.passwordPlaceholder")}
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

      {error ? <p className="auth-error">{error}</p> : null}

      <button className="auth-submit" type="submit" disabled={loading}>
        {loading ? t("auth.signingIn") : t("auth.signIn")}
      </button>

      <p className="auth-switch">
        {t("auth.needAccount")} {" "}
        <button type="button" className="auth-link" onClick={onSwitchToRegister}>
          {t("auth.createOne")}
        </button>
      </p>
    </form>
  );
}
