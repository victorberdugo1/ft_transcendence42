export default function RequestStateCard({
  className,
  kicker,
  kickerClassName,
  title,
  message,
  headingTag = "h2",
  actions,
}) {
  const Heading = headingTag;

  return (
    <section className={className}>
      {kicker ? <span className={kickerClassName}>{kicker}</span> : null}
      <Heading>{title}</Heading>
      <p>{message}</p>
      {actions || null}
    </section>
  );
}
