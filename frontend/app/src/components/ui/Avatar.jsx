import { useEffect, useState } from "react";

function getInitials(label = "") {
  if (!label) return "?";
  return label
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);
}

export default function Avatar({
  src,
  label = "",
  className = "",
  size = "medium",
  t,
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const sizeClass = `avatar-${size}`;
  const combinedClassName = `avatar ${sizeClass} ${className}`.trim();

  if (src && !failed) {
    return (
      <img
        className={combinedClassName}
        src={src}
        alt={label || (t ? t("avatar.alt") : "User avatar")}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className={`${combinedClassName} avatar-fallback`}
      aria-label={label || (t ? t("avatar.alt") : "User avatar")}
    >
      {getInitials(label)}
    </div>
  );
}
