export default function ProfileEmptyState({ title, text }) {
  return (
    <div className="profile-empty">
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}
