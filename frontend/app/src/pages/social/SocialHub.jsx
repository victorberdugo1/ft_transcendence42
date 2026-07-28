import PageHeader from "@src/components/ui/PageHeader.jsx";
import { apiFetchJson } from "@src/utils/http.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./social.css";

const POLL_MS = 5000;

function formatDateTime(value, language) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatCompactTime(value, language) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function applyProtectedDeletion(event, value, setValue) {
  const isDeleteKey = event.key === "Backspace" || event.key === "Delete";
  if (!isDeleteKey || event.altKey || event.ctrlKey || event.metaKey) return;

  const input = event.currentTarget;
  const start = input.selectionStart ?? value.length;
  const end = input.selectionEnd ?? start;

  if (start !== end) {
    event.preventDefault();
    setValue(`${value.slice(0, start)}${value.slice(end)}`);
    return;
  }

  if (event.key === "Backspace" && start > 0) {
    event.preventDefault();
    setValue(`${value.slice(0, start - 1)}${value.slice(start)}`);
    return;
  }

  if (event.key === "Delete" && start < value.length) {
    event.preventDefault();
    setValue(`${value.slice(0, start)}${value.slice(start + 1)}`);
  }
}

function PresenceBadge({ presence, t }) {
  const state = presence?.state || "offline";
  const label = t(`socialHub.presence.${state}`);
  return <span className={`social-presence social-presence-${state}`}>{label}</span>;
}

function SidebarEntry({ active, kicker, title, meta, unread, onClick }) {
  return (
    <button
      type="button"
      className={active ? "social-side-entry social-side-entry-active" : "social-side-entry"}
      onClick={onClick}
    >
      <span className="social-side-kicker">{kicker}</span>
      <strong>{title}</strong>
      {meta ? <span className="social-side-meta">{meta}</span> : null}
      {unread ? <span className="social-side-unread">{unread}</span> : null}
    </button>
  );
}

function ThreadMessage({ message, currentUserId, language, t, mode }) {
  const own = Number(message.sender_id ?? message.senderId) === Number(currentUserId);
  const senderName = own ? null : message.sender?.username || message.sender_username || "";
  const senderLabel = own ? t("socialHub.you") : senderName;

  return (
    <article className={own ? "social-message social-message-own" : "social-message"}>
      <div className="social-message-topline">
        <span className={own ? "social-message-tag social-message-tag-own" : "social-message-tag"}>
          {mode === "channel" || own ? senderLabel : senderName}
        </span>
        <time>{formatCompactTime(message.sent_at || message.sentAt, language)}</time>
      </div>
      <p>{message.content}</p>
    </article>
  );
}

export default function SocialHub({ user, onBack, initialTab = "global" }) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language || "en";
  const [hubStatus, setHubStatus] = useState("loading");
  const [threadStatus, setThreadStatus] = useState("idle");
  const [error, setError] = useState("");
  const [hub, setHub] = useState({ friends: [], requests: [], conversations: [], channels: [] });
  const [activeTab, setActiveTab] = useState(initialTab);
  const [selection, setSelection] = useState(null);
  const [threadMessages, setThreadMessages] = useState([]);
  const [composer, setComposer] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const scrollRef = useRef(null);

  const selectDefault = useCallback((tab, nextHub) => {
    if (tab === "global") {
      const channel = nextHub.channels[0];
      return channel ? { type: "channel", key: channel.key, channel } : null;
    }
    if (tab === "direct") {
      const conversation = nextHub.conversations[0];
      return conversation ? { type: "direct", user: conversation.user } : null;
    }
    if (tab === "friends") {
      const friend = nextHub.friends[0];
      return friend ? { type: "friend", user: friend } : null;
    }
    if (tab === "requests") {
      const request = nextHub.requests[0];
      return request ? { type: "request", user: request } : null;
    }
    return null;
  }, []);

  const loadHub = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setHubStatus("loading");
    try {
      const data = await apiFetchJson("/api/chat/overview");
      setHub(data);
      setHubStatus("ready");
      setError("");
      return data;
    } catch (loadError) {
      setHubStatus("error");
      setError(loadError.message || t("socialHub.errors.loadHub"));
      throw loadError;
    }
  }, [t]);

  const loadThread = useCallback(async (target, { silent = false, markRead = true } = {}) => {
    if (!target || (target.type !== "channel" && target.type !== "direct")) {
      setThreadMessages([]);
      setThreadStatus("idle");
      return;
    }

    if (!silent) setThreadStatus("loading");
    try {
      if (target.type === "channel") {
        const data = await apiFetchJson(`/api/chat/channels/${target.key}/messages?limit=120`);
        setThreadMessages(Array.isArray(data.messages) ? data.messages : []);
      } else {
        const data = await apiFetchJson(`/api/messages/${target.user.id}?limit=120`);
        const messages = Array.isArray(data.messages) ? data.messages : [];
        setThreadMessages(messages);

        if (markRead) {
          const hasUnreadIncoming = messages.some(
            (message) => Number(message.sender_id) === Number(target.user.id) && message.is_read === false
          );
          if (hasUnreadIncoming) {
            await apiFetchJson(`/api/messages/${target.user.id}/read`, { method: "PUT" });
            await loadHub({ silent: true });
          }
        }
      }
      setThreadStatus("ready");
      setError("");
    } catch (loadError) {
      setThreadStatus("error");
      setError(loadError.message || t("socialHub.errors.loadThread"));
    }
  }, [loadHub, t]);

  useEffect(() => {
    let cancelled = false;
    loadHub()
      .then((data) => {
        if (cancelled) return;
        setSelection(selectDefault(initialTab, data));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialTab, loadHub, selectDefault]);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    const nextDefault = selectDefault(activeTab, hub);
    if (!selection) {
      setSelection(nextDefault);
      return;
    }

    if (activeTab === "global" && selection.type !== "channel") {
      setSelection(nextDefault);
      return;
    }
    if (activeTab === "direct" && selection.type !== "direct") {
      setSelection(nextDefault);
      return;
    }
    if (activeTab === "friends" && selection.type !== "friend") {
      setSelection(nextDefault);
      return;
    }
    if (activeTab === "requests" && selection.type !== "request") {
      setSelection(nextDefault);
      return;
    }

    if (selection.type === "direct") {
      const stillExists = hub.conversations.some((conversation) => conversation.user.id === selection.user.id)
        || hub.friends.some((friend) => friend.id === selection.user.id);
      if (!stillExists) setSelection(nextDefault);
    }

    if (selection.type === "friend" && !hub.friends.some((friend) => friend.id === selection.user.id)) {
      setSelection(nextDefault);
    }
    if (selection.type === "request" && !hub.requests.some((request) => request.id === selection.user.id)) {
      setSelection(nextDefault);
    }
  }, [activeTab, hub, selection, selectDefault]);

  useEffect(() => {
    loadThread(selection, { markRead: true });
  }, [selection, loadThread]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [threadMessages]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      loadHub({ silent: true }).catch(() => {});
      loadThread(selection, { silent: true, markRead: false });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadHub, loadThread, selection]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearchBusy(false);
      return undefined;
    }

    const timer = window.setTimeout(async () => {
      setSearchBusy(true);
      try {
        const data = await apiFetchJson(`/api/chat/users?q=${encodeURIComponent(query)}`);
        setSearchResults(Array.isArray(data.users) ? data.users : []);
      } catch (_) {
        setSearchResults([]);
      } finally {
        setSearchBusy(false);
      }
    }, 260);

    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const onlineFriends = hub.friends.filter((friend) => friend.presence?.online).length;
  const unreadTotal = hub.conversations.reduce((sum, conversation) => sum + (conversation.unreadCount || 0), 0);
  const pendingCount = hub.requests.length;
  const selectedFriend = selection?.type === "friend" ? selection.user : null;
  const selectedRequest = selection?.type === "request" ? selection.user : null;
  const selectedDirect = selection?.type === "direct" ? selection.user : null;
  const selectedChannel = selection?.type === "channel" ? selection.channel || hub.channels[0] : null;
  const showThread = selection?.type === "channel" || selection?.type === "direct";

  const contextTitle = useMemo(() => {
    if (selectedChannel) return selectedChannel.title;
    if (selectedDirect) return selectedDirect.username;
    if (selectedFriend) return selectedFriend.username;
    if (selectedRequest) return selectedRequest.username;
    return t("socialHub.empty.title");
  }, [selectedChannel, selectedDirect, selectedFriend, selectedRequest, t]);

  const contextDescription = useMemo(() => {
    if (selectedChannel) return t("socialHub.context.global");
    if (selectedDirect) return t("socialHub.context.direct", { playerName: selectedDirect.username });
    if (selectedFriend) return t("socialHub.context.friend", { playerName: selectedFriend.username });
    if (selectedRequest) return t("socialHub.context.request", { playerName: selectedRequest.username });
    return t("socialHub.empty.description");
  }, [selectedChannel, selectedDirect, selectedFriend, selectedRequest, t]);

  async function handleSendMessage(event) {
    event.preventDefault();
    const content = composer.trim();
    if (!content || sendBusy) return;
    if (!selection || (selection.type !== "channel" && selection.type !== "direct")) return;

    setSendBusy(true);
    try {
      if (selection.type === "channel") {
        await apiFetchJson(`/api/chat/channels/${selection.key}/messages`, {
          method: "POST",
          body: JSON.stringify({ content }),
        });
      } else {
        await apiFetchJson(`/api/messages/${selection.user.id}`, {
          method: "POST",
          body: JSON.stringify({ content }),
        });
      }
      setComposer("");
      await Promise.all([
        loadThread(selection, { silent: true, markRead: false }),
        loadHub({ silent: true }),
      ]);
    } catch (sendError) {
      setError(sendError.message || t("socialHub.errors.sendMessage"));
    } finally {
      setSendBusy(false);
    }
  }

  async function handleAcceptRequest(requestUserId) {
    setActionBusy(`accept-${requestUserId}`);
    try {
      await apiFetchJson(`/api/friends/${requestUserId}`, { method: "PUT" });
      const data = await loadHub({ silent: true });
      setSelection(selectDefault(activeTab, data));
    } catch (actionError) {
      setError(actionError.message || t("socialHub.errors.acceptRequest"));
    } finally {
      setActionBusy("");
    }
  }

  async function handleDismissRequest(requestUserId) {
    setActionBusy(`dismiss-${requestUserId}`);
    try {
      await apiFetchJson(`/api/friends/${requestUserId}`, { method: "DELETE" });
      const data = await loadHub({ silent: true });
      setSelection(selectDefault(activeTab, data));
    } catch (actionError) {
      setError(actionError.message || t("socialHub.errors.dismissRequest"));
    } finally {
      setActionBusy("");
    }
  }

  async function handleSendRequest(targetUserId) {
    setActionBusy(`request-${targetUserId}`);
    try {
      await apiFetchJson(`/api/friends/${targetUserId}`, { method: "POST" });
      await loadHub({ silent: true });
      setSearchResults((current) => current.map((entry) => (
        entry.id === targetUserId ? { ...entry, friendshipStatus: "outgoing" } : entry
      )));
    } catch (actionError) {
      setError(actionError.message || t("socialHub.errors.sendRequest"));
    } finally {
      setActionBusy("");
    }
  }

  async function handleRemoveFriend(friendUserId) {
    setActionBusy(`remove-${friendUserId}`);
    try {
      const wasSelected = selectedFriend?.id === friendUserId;
      const data = await apiFetchJson(`/api/friends/${friendUserId}`, { method: "DELETE" }).then(() => loadHub({ silent: true }));
      if (wasSelected) setSelection(selectDefault("friends", data));
    } catch (actionError) {
      setError(actionError.message || t("socialHub.errors.removeFriend"));
    } finally {
      setActionBusy("");
    }
  }

  function openDirect(userSummary) {
    setActiveTab("direct");
    setSelection({ type: "direct", user: userSummary });
  }

  return (
    <div className="social-page">
      <div className="social-shell">
        <PageHeader
          className="social-header"
          kickerClassName="social-kicker"
          actionsClassName="social-header-actions"
          kicker={t("socialHub.kicker")}
          title={t("socialHub.title")}
          subtitle={t("socialHub.subtitle", { playerName: user.username || user.email })}
          onBack={onBack}
          backLabel={t("socialHub.backToLobby")}
        />

        <section className="social-summary">
          <div className="social-stat social-stat-cyan">
            <strong>{onlineFriends}</strong>
            <span>{t("socialHub.summary.onlineFriends")}</span>
          </div>
          <div className="social-stat social-stat-gold">
            <strong>{unreadTotal}</strong>
            <span>{t("socialHub.summary.unread")}</span>
          </div>
          <div className="social-stat social-stat-pink">
            <strong>{pendingCount}</strong>
            <span>{t("socialHub.summary.pending")}</span>
          </div>
        </section>

        <section className="social-tabs" aria-label={t("socialHub.tabs.label")}>
          {[
            ["global", t("socialHub.tabs.global")],
            ["direct", t("socialHub.tabs.direct")],
            ["friends", t("socialHub.tabs.friends")],
            ["requests", t("socialHub.tabs.requests")],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={activeTab === value ? "social-tab social-tab-active" : "social-tab"}
              onClick={() => setActiveTab(value)}
            >
              {label}
              {value === "direct" && unreadTotal ? <span className="social-tab-count">{unreadTotal}</span> : null}
              {value === "requests" && pendingCount ? <span className="social-tab-count">{pendingCount}</span> : null}
            </button>
          ))}
        </section>

        {hubStatus === "error" ? <div className="social-error-banner">{error}</div> : null}

        <div className="social-layout grid grid-cols-[minmax(250px,300px)_minmax(0,1fr)_minmax(250px,320px)] max-[1180px]:grid-cols-[minmax(240px,280px)_minmax(0,1fr)] max-[880px]:grid-cols-1">
          <aside className="social-sidebar">
            <div className="social-side-block">
              <span className="social-side-title">{t(`socialHub.sideTitles.${activeTab}`)}</span>

              {activeTab === "global" ? hub.channels.map((channel) => (
                <SidebarEntry
                  key={channel.key}
                  active={selection?.type === "channel" && selection.key === channel.key}
                  kicker={t("socialHub.channelKicker")}
                  title={channel.title}
                  meta={channel.lastMessage ? `${channel.lastSenderUsername || ""} · ${formatDateTime(channel.lastMessageAt, language)}` : t("socialHub.noMessagesYet")}
                  onClick={() => setSelection({ type: "channel", key: channel.key, channel })}
                />
              )) : null}

              {activeTab === "direct" ? hub.conversations.map((conversation) => (
                <SidebarEntry
                  key={conversation.user.id}
                  active={selection?.type === "direct" && selection.user.id === conversation.user.id}
                  kicker={conversation.user.presence?.label || t("socialHub.presence.offline")}
                  title={conversation.user.username}
                  meta={conversation.lastMessage ? `${conversation.lastMessage} · ${formatDateTime(conversation.lastMessageAt, language)}` : t("socialHub.noMessagesYet")}
                  unread={conversation.unreadCount}
                  onClick={() => setSelection({ type: "direct", user: conversation.user })}
                />
              )) : null}

              {activeTab === "friends" ? hub.friends.map((friend) => (
                <SidebarEntry
                  key={friend.id}
                  active={selection?.type === "friend" && selection.user.id === friend.id}
                  kicker={friend.presence?.label || t("socialHub.presence.offline")}
                  title={friend.username}
                  meta={t("socialHub.friendMeta")}
                  onClick={() => setSelection({ type: "friend", user: friend })}
                />
              )) : null}

              {activeTab === "requests" ? hub.requests.map((request) => (
                <SidebarEntry
                  key={request.id}
                  active={selection?.type === "request" && selection.user.id === request.id}
                  kicker={t("socialHub.requestKicker")}
                  title={request.username}
                  meta={formatDateTime(request.createdAt, language)}
                  onClick={() => setSelection({ type: "request", user: request })}
                />
              )) : null}

              {((activeTab === "direct" && !hub.conversations.length)
                || (activeTab === "friends" && !hub.friends.length)
                || (activeTab === "requests" && !hub.requests.length)) ? (
                <div className="social-side-empty">{t("socialHub.emptySidebar")}</div>
              ) : null}
            </div>
          </aside>

          <main className="social-main">
            <div className="social-main-header">
              <div className="social-main-copy">
                <span className="social-main-kicker">{t(`socialHub.mainKickers.${selection?.type || "empty"}`)}</span>
                <h2>{contextTitle}</h2>
                <p>{contextDescription}</p>
              </div>
              {selectedDirect ? <PresenceBadge presence={selectedDirect.presence} t={t} /> : null}
              {selectedFriend ? <PresenceBadge presence={selectedFriend.presence} t={t} /> : null}
            </div>

            {showThread ? (
              <div className="social-conversation-shell">
                <div className="social-thread-surface">
                  <div className="social-thread-summary">
                    <span>{t("socialHub.messagesCount", { count: threadMessages.length })}</span>
                    <strong>{selection.type === "channel" ? t("socialHub.threadState.live") : t("socialHub.threadState.private")}</strong>
                  </div>

                  <div className="social-thread" ref={scrollRef}>
                  {threadStatus === "loading" ? <div className="social-empty-panel">{t("socialHub.loadingThread")}</div> : null}
                  {threadStatus === "ready" && !threadMessages.length ? <div className="social-empty-panel">{t("socialHub.emptyThread")}</div> : null}
                  {threadMessages.map((message) => (
                    <ThreadMessage
                      key={message.id}
                      message={message}
                      currentUserId={user.id}
                      language={language}
                      mode={selection.type}
                      t={t}
                    />
                  ))}
                </div>
                </div>

                <form className="social-composer" onSubmit={handleSendMessage}>
                  <label className="social-composer-field">
                    <span className="social-composer-label">{t("socialHub.composerLabel")}</span>
                    <textarea
                      value={composer}
                      onChange={(event) => setComposer(event.target.value)}
                      onKeyDown={(event) => applyProtectedDeletion(event, composer, setComposer)}
                      placeholder={t("socialHub.messagePlaceholder")}
                      maxLength={500}
                    />
                  </label>
                  <div className="social-composer-footer">
                    <div className="social-composer-meta">
                      <span>{selection.type === "channel" ? t("socialHub.threadState.channelHint") : t("socialHub.threadState.directHint")}</span>
                      <strong>{composer.length}/500</strong>
                    </div>
                    <button type="submit" disabled={sendBusy || !composer.trim()}>
                      {sendBusy ? t("socialHub.sending") : t("socialHub.send")}
                    </button>
                  </div>
                </form>
              </div>
            ) : null}

            {selection?.type === "friend" ? (
              <div className="social-profile-card">
                <div className="social-profile-top">
                  <div>
                    <span className="social-main-kicker">{t("socialHub.friendCardKicker")}</span>
                    <h3>{selectedFriend.username}</h3>
                  </div>
                  <PresenceBadge presence={selectedFriend.presence} t={t} />
                </div>
                <p>{t("socialHub.friendDescription", { playerName: selectedFriend.username })}</p>
                <div className="social-profile-actions">
                  <button type="button" className="social-action-primary" onClick={() => openDirect(selectedFriend)}>
                    {t("socialHub.actions.openChat")}
                  </button>
                  <button
                    type="button"
                    className="social-action-ghost"
                    onClick={() => handleRemoveFriend(selectedFriend.id)}
                    disabled={actionBusy === `remove-${selectedFriend.id}`}
                  >
                    {actionBusy === `remove-${selectedFriend.id}` ? t("socialHub.actions.working") : t("socialHub.actions.removeFriend")}
                  </button>
                </div>
              </div>
            ) : null}

            {selection?.type === "request" ? (
              <div className="social-profile-card">
                <div className="social-profile-top">
                  <div>
                    <span className="social-main-kicker">{t("socialHub.requestKicker")}</span>
                    <h3>{selectedRequest.username}</h3>
                  </div>
                  <PresenceBadge presence={selectedRequest.presence} t={t} />
                </div>
                <p>{t("socialHub.requestDescription", { playerName: selectedRequest.username })}</p>
                <div className="social-profile-actions">
                  <button
                    type="button"
                    className="social-action-primary"
                    onClick={() => handleAcceptRequest(selectedRequest.id)}
                    disabled={actionBusy === `accept-${selectedRequest.id}`}
                  >
                    {actionBusy === `accept-${selectedRequest.id}` ? t("socialHub.actions.working") : t("socialHub.actions.accept")}
                  </button>
                  <button
                    type="button"
                    className="social-action-ghost"
                    onClick={() => handleDismissRequest(selectedRequest.id)}
                    disabled={actionBusy === `dismiss-${selectedRequest.id}`}
                  >
                    {actionBusy === `dismiss-${selectedRequest.id}` ? t("socialHub.actions.working") : t("socialHub.actions.dismiss")}
                  </button>
                </div>
              </div>
            ) : null}

            {!selection ? <div className="social-empty-panel">{t("socialHub.empty.title")}</div> : null}
          </main>

          <aside className="social-rail">
            <div className="social-side-block">
              <span className="social-side-title">{t("socialHub.discovery.title")}</span>
              <label className="social-search-box">
                <span>{t("socialHub.discovery.label")}</span>
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => applyProtectedDeletion(event, searchQuery, setSearchQuery)}
                  placeholder={t("socialHub.discovery.placeholder")}
                />
              </label>

              {searchBusy ? <div className="social-side-empty">{t("socialHub.discovery.searching")}</div> : null}
              {!searchBusy && searchQuery.trim().length >= 2 && !searchResults.length ? (
                <div className="social-side-empty">{t("socialHub.discovery.noResults")}</div>
              ) : null}

              {searchResults.map((entry) => (
                <div key={entry.id} className="social-search-result">
                  <div>
                    <strong>{entry.username}</strong>
                    <PresenceBadge presence={entry.presence} t={t} />
                  </div>
                  <div className="social-search-actions">
                    {entry.friendshipStatus === "accepted" ? (
                      <button type="button" className="social-link-button" onClick={() => openDirect(entry)}>
                        {t("socialHub.actions.message")}
                      </button>
                    ) : null}
                    {entry.friendshipStatus === "none" ? (
                      <button
                        type="button"
                        className="social-link-button"
                        onClick={() => handleSendRequest(entry.id)}
                        disabled={actionBusy === `request-${entry.id}`}
                      >
                        {actionBusy === `request-${entry.id}` ? t("socialHub.actions.working") : t("socialHub.actions.addFriend")}
                      </button>
                    ) : null}
                    {entry.friendshipStatus === "outgoing" ? <span className="social-inline-note">{t("socialHub.discovery.outgoing")}</span> : null}
                    {entry.friendshipStatus === "incoming" ? <span className="social-inline-note">{t("socialHub.discovery.incoming")}</span> : null}
                  </div>
                </div>
              ))}
            </div>

            <div className="social-side-block">
              <span className="social-side-title">{t("socialHub.overview.title")}</span>
              <ul className="social-overview-list">
                <li>
                  <strong>{hub.channels.length}</strong>
                  <span>{t("socialHub.overview.channels")}</span>
                </li>
                <li>
                  <strong>{hub.conversations.length}</strong>
                  <span>{t("socialHub.overview.direct")}</span>
                </li>
                <li>
                  <strong>{hub.friends.length}</strong>
                  <span>{t("socialHub.overview.friends")}</span>
                </li>
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
