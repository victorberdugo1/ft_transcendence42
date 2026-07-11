export default function ProfileStatTile({ label, value }) {
  const variant = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className={`profile-stat-tile profile-stat-${variant}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
