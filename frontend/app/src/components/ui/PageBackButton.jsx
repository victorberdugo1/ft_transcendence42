export default function PageBackButton({
  children,
  type = "button",
  ...buttonProps
}) {
  return (
    <button {...buttonProps} type={type} className="page-back-btn">
      {children}
    </button>
  );
}
