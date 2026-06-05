export default function Terms({ onBack }) {
  return (
    <div className="auth-page">
      <div className="auth-card legal-card">
        <button type="button" className="auth-link legal-back" onClick={onBack}>
          Back
        </button>

        <p className="auth-eyebrow">Enuma Fighter</p>
        <h1 className="auth-title">Terms of Service</h1>
        <p className="auth-subtitle">
          These terms and conditions apply to the Enuma Fighter app for web
          browsers and related services operated by aprenafe, isegura-, mmarinov,
          vberdugo, fcela-ga (the "Service Provider"). By using the Application,
          you agree to these Terms. Effective as of 2026-06-05.
        </p>

        <section className="legal-section">
          <h2>License to Use the Application</h2>
          <p>
            The Service Provider grants you a limited, non-exclusive,
            non-transferable, revocable license to use the Application for
            personal or internal business purposes. You may not reproduce,
            distribute, modify, create derivative works from, reverse engineer,
            decompile, or disassemble the Application except as expressly
            permitted by applicable law.
          </p>
        </section>

        <section className="legal-section">
          <h2>Intellectual Property</h2>
          <p>
            The Service Provider retains all intellectual property rights in the
            Application, including its code, design, trademarks, service marks,
            trade names, logos, and branding. Nothing in these Terms grants you
            any license or right to use the Service Provider's trademarks, logos,
            or branding for any purpose.
          </p>
        </section>

        <section className="legal-section">
          <h2>Termination</h2>
          <p>
            The Service Provider may suspend your access if you materially breach
            these Terms, providing 14 days written notice to remedy the breach
            where possible. Immediate suspension without notice may occur for
            violations of applicable law, intellectual property infringement, or
            activity that could harm other users or the Service Provider.
          </p>
        </section>

        <section className="legal-section">
          <h2>Eligibility</h2>
          <p>
            You must be at least 16 years of age to use the Application. By
            accessing and using this Application, you represent that you are
            legally permitted to use it in your jurisdiction. If you are below
            16, a parent or legal guardian must review and accept these Terms
            on your behalf.
          </p>
        </section>

        <section className="legal-section">
          <h2>User-Generated Content and Acceptable Use</h2>
          <p>
            You agree not to post content that is illegal, abusive, threatening,
            defamatory, discriminatory, spam, phishing, misleading, or that
            violates the privacy or intellectual property rights of others. The
            Service Provider reserves the right to remove violating content,
            suspend or terminate accounts of repeat violators, and cooperate
            with law enforcement where required.
          </p>
          <p>
            By submitting content, you grant the Service Provider a non-exclusive,
            worldwide, royalty-free license to use, reproduce, distribute, and
            display your content in connection with the Application. You represent
            that you own or control all rights in the content you submit.
          </p>
          <p>
            To report content that violates these Terms, contact the Service
            Provider at aprenafe, isegura-, mmarinov, vberdugo, fcela-ga.
          </p>
        </section>

        <section className="legal-section">
          <h2>Limitation of Liability</h2>
          <p>
            To the fullest extent permitted by law, the Service Provider shall
            not be liable for any indirect, incidental, special, consequential,
            or punitive damages. The Service Provider retains full liability for
            death or personal injury caused by negligence, fraud or fraudulent
            misrepresentation, and any other liability that cannot be excluded
            under applicable law.
          </p>
        </section>

        <section className="legal-section">
          <h2>Indemnification</h2>
          <p>
            To the fullest extent permitted by law, you agree to indemnify and
            hold harmless the Service Provider, its affiliates, officers,
            directors, employees and agents from claims arising out of your
            breach of these Terms or your intentional misuse of the Application.
            This does not apply to claims arising from the Service Provider's
            own negligence or violation of applicable law.
          </p>
        </section>

        <section className="legal-section">
          <h2>Governing Law and Jurisdiction</h2>
          <p>
            These Terms are governed by the laws of the jurisdiction in which
            the Service Provider is established, excluding conflict of law rules,
            except to the extent mandatory consumer protection laws provide
            otherwise. Nothing limits any rights you may have under mandatory law.
          </p>
        </section>

        <section className="legal-section">
          <h2>DSA Compliance (Digital Services Act)</h2>
          <p>
            Where the Application qualifies as an intermediary service under the
            Digital Services Act (EU 2022/2065), the Service Provider maintains
            a point of contact for EU authorities at aprenafe, isegura-, mmarinov,
            vberdugo, fcela-ga. Content moderation decisions include a statement
            of reasons and information on available redress mechanisms. Users may
            submit content notices to the contact details provided; disputes may
            be submitted to a certified out-of-court dispute settlement body.
          </p>
        </section>

        <section className="legal-section">
          <h2>Changes to These Terms</h2>
          <p>
            The Service Provider may periodically update these Terms and will
            notify you by posting the updated version on this page with an
            effective date. Previous versions are available upon request by
            contacting the Service Provider at aprenafe, isegura-, mmarinov,
            vberdugo, fcela-ga.
          </p>
        </section>

        <section className="legal-section">
          <h2>Contact Us</h2>
          <p>
            If you have any questions or suggestions about these Terms and
            Conditions, please contact the Service Provider at aprenafe,
            isegura-, mmarinov, vberdugo, fcela-ga.
          </p>
        </section>
      </div>
    </div>
  );
}
