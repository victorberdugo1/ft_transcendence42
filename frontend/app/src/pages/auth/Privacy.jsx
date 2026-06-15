import logoImage from "../../../assets/logo.png";

export default function Privacy({ onBack }) {
  return (
    <div className="auth-page">
      <div className="auth-card legal-card">
        <button type="button" className="auth-link legal-back" onClick={onBack}>
          Back
        </button>

        <div className="legal-crest">
          <img src={logoImage} alt="Enuma Fighter logo" className="legal-crest-image" />
        </div>

        <p className="auth-eyebrow">Enuma Fighter</p>
        <h1 className="auth-title">Privacy Policy</h1>
        <p className="auth-subtitle">
          This privacy policy applies to the Enuma Fighter app for web browsers,
          together with any related services operated by aprenafe, isegura-,
          mmarinov, vberdugo, fcela-ga (collectively, the "Application"), hereby
          referred to as the "Service Provider". Effective as of 2026-06-05.
        </p>

        <section className="legal-section">
          <h2>Information Collection and Use</h2>
          <p>
            The Application collects information when you download and use it.
            This information may include your device's Internet Protocol address,
            the pages you visit and time spent on them, and your operating system.
          </p>
        </section>

        <section className="legal-section">
          <h2>Cookies and Tracking Technologies</h2>
          <p>
            The Application or its third-party SDKs may use cookies, SDKs, pixels,
            and similar technologies to support functionality, analytics, or service
            delivery. Where required by applicable law, the Service Provider will
            obtain consent before using non-essential tracking technologies.
          </p>
        </section>

        <section className="legal-section">
          <h2>Your Rights</h2>
          <p>
            You may request access to, correction of, or deletion of your personal
            data held by the Service Provider. To exercise these rights, or to
            withdraw consent where processing is based on consent, contact the
            Service Provider at aprenafe, isegura-, mmarinov, vberdugo, fcela-ga.
          </p>
        </section>

        <section className="legal-section">
          <h2>Your California Privacy Rights (CCPA/CPRA)</h2>
          <p>
            If you are a California resident, you have the right to know what
            personal information is collected, the right to delete personal
            information, the right to opt out of the sale or sharing of personal
            information, and the right to non-discrimination for exercising these
            rights. To exercise your CCPA/CPRA rights, contact the Service Provider
            at aprenafe, isegura-, mmarinov, vberdugo, fcela-ga.
          </p>
        </section>

        <section className="legal-section">
          <h2>Third Party Access</h2>
          <p>
            Only aggregated, anonymized data is periodically transmitted to external
            services to aid the Service Provider in improving the Application. The
            Service Provider may disclose information as required by law, to protect
            rights or safety, investigate fraud, or respond to a government request,
            and with trusted service providers who have agreed to adhere to the rules
            set forth in this privacy statement.
          </p>
        </section>

        <section className="legal-section">
          <h2>International Data Transfers</h2>
          <p>
            The Service Provider or its third-party service providers may transfer
            personal data to countries outside your country of residence, including
            outside the European Economic Area (EEA). Where applicable law requires
            safeguards, the Service Provider will use Standard Contractual Clauses,
            adequacy decisions, or other legally recognized transfer mechanisms.
          </p>
        </section>

        <section className="legal-section">
          <h2>Opt-Out Rights</h2>
          <p>
            You can stop further collection of information by ceasing to use the
            website. To request deletion of your personal data or to withdraw
            consent, contact the Service Provider at aprenafe, isegura-, mmarinov,
            vberdugo, fcela-ga.
          </p>
        </section>

        <section className="legal-section">
          <h2>Data Retention Policy</h2>
          <p>
            User Provided Data is retained for the duration of your use plus 12
            months thereafter. Automatically Collected Data is retained for up to
            24 months from collection. Aggregated and Anonymized Data may be
            retained indefinitely. Data required for legal compliance is retained
            as long as required by applicable law.
          </p>
        </section>

        <section className="legal-section">
          <h2>Children</h2>
          <p>
            The Application is not intended for children under 16 years of age.
            The Service Provider does not knowingly collect personally identifiable
            information from children. If you believe a child has provided personal
            information, contact the Service Provider at aprenafe, isegura-,
            mmarinov, vberdugo, fcela-ga.
          </p>
        </section>

        <section className="legal-section">
          <h2>Security</h2>
          <p>
            The Service Provider provides physical, electronic, and procedural
            safeguards to protect information it processes and maintains. In the
            event of a data breach affecting your personal data, the Service
            Provider will notify you in accordance with applicable legal requirements.
          </p>
        </section>

        <section className="legal-section">
          <h2>Changes</h2>
          <p>
            The Service Provider may update this Privacy Policy from time to time
            and will notify you of material changes by posting the updated policy
            with an effective date. Previous versions will be maintained and made
            available upon request.
          </p>
        </section>

        <section className="legal-section">
          <h2>Your Consent</h2>
          <p>
            Where processing is based on consent, you provide that consent by
            affirmatively opting in to the relevant feature or action. You may
            withdraw consent at any time without affecting processing carried out
            before withdrawal.
          </p>
        </section>

        <section className="legal-section">
          <h2>Contact Us</h2>
          <p>
            If you have any questions regarding privacy while using the Application,
            please contact the Service Provider via email at aprenafe, isegura-,
            mmarinov, vberdugo, fcela-ga.
          </p>
        </section>
      </div>
    </div>
  );
}
