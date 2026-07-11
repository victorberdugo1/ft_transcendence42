import LanguageSelector from "@src/components/LanguageSelector.jsx";
import PageBackButton from "@src/components/ui/PageBackButton.jsx";

export default function PageHeader({
  className,
  kickerClassName,
  actionsClassName,
  kicker,
  title,
  subtitle,
  onBack,
  backLabel,
}) {
  return (
    <header className={className}>
      <div>
        <span className={kickerClassName}>{kicker}</span>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      <div className={actionsClassName}>
        <LanguageSelector variant="manual" compact />
        <PageBackButton onClick={onBack}>{backLabel}</PageBackButton>
      </div>
    </header>
  );
}
