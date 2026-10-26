import Sheet from 'app/dim-ui/Sheet';
import { useHotkey } from 'app/hotkeys/useHotkey';
import { useThunkDispatch } from 'app/store/thunk-dispatch';
import { RootState } from 'app/store/types';
import { useEventBusListener, useLocalStorage } from 'app/utils/hooks';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'react-redux';
import * as styles from './AiAssistant.m.scss';
import {
  AgentDeps,
  ChatLine,
  Conversation,
  emptyConversation,
  PendingAction,
  resolvePendingAction,
  sendUserMessage,
  TurnResult,
} from './agent';
import { toggleAiAssistant$ } from './events';

/** localStorage keys for the proxy Worker URL and its access token. */
const PROXY_URL_KEY = 'dim-ai-proxy-url';
const PROXY_TOKEN_KEY = 'dim-ai-proxy-token';

const lineClassNames: Record<ChatLine['kind'], string> = {
  user: styles.user,
  model: styles.model,
  activity: styles.activity,
  error: styles.error,
};

/**
 * A chat panel that answers questions about the player's gear and moves,
 * equips and saves loadouts through DIM's own actions. English-only for now,
 * since it's behind the dev-only aiAssistant feature flag.
 */
export default function AiAssistant() {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  useEventBusListener(toggleAiAssistant$, toggle);
  useHotkey('shift+a', 'Toggle AI assistant', toggle);

  // Keep the conversation while the panel is closed
  const [lines, setLines] = useState<ChatLine[]>([]);
  const conversation = useRef<Conversation>(emptyConversation);
  const [pending, setPending] = useState<PendingAction>();
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [proxyUrl, setProxyUrl] = useLocalStorage(PROXY_URL_KEY, $DIM_AI_PROXY_URL);
  const [proxyToken, setProxyToken] = useLocalStorage(PROXY_TOKEN_KEY, '');
  const [showSettings, setShowSettings] = useState(!proxyUrl || !proxyToken);

  const dispatch = useThunkDispatch();
  const store = useStore<RootState>();

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [lines, pending]);

  const run = async (step: (deps: AgentDeps) => Promise<TurnResult>) => {
    setBusy(true);
    try {
      const result = await step({
        proxyUrl,
        proxyToken,
        getState: () => store.getState(),
        dispatch,
        onLine: (line) => setLines((l) => [...l, line]),
      });
      conversation.current = result.conversation;
      setPending(result.pending);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || pending) {
      return;
    }
    if (!proxyUrl || !proxyToken) {
      setShowSettings(true);
      setLines((l) => [
        ...l,
        { kind: 'error', text: 'Set the AI proxy Worker URL and access token first.' },
      ]);
      return;
    }
    setInput('');
    void run((deps) => sendUserMessage(deps, conversation.current, text));
  };

  const handleResolve = (confirmed: boolean) => {
    if (!pending || busy) {
      return;
    }
    const action = pending;
    setPending(undefined);
    void run((deps) => resolvePendingAction(deps, conversation.current, action, confirmed));
  };

  const handleClear = () => {
    conversation.current = emptyConversation;
    setLines([]);
    setPending(undefined);
  };

  if (!open) {
    return null;
  }

  const header = (
    <div className={styles.header}>
      <h1>AI Assistant</h1>
      <div className={styles.privacy}>
        Uses Claude (Anthropic). If Claude is unavailable it falls back to Google's free Gemini
        tier, where prompts may be used to improve Google's products. Item names and stats are sent;
        account ids are not.
      </div>
      {showSettings ? (
        <>
          <label className={styles.settings}>
            Worker URL
            <input
              type="url"
              value={proxyUrl}
              placeholder="https://dim-ai-proxy.<subdomain>.workers.dev"
              onChange={(e) => setProxyUrl(e.target.value.trim())}
            />
          </label>
          <label className={styles.settings}>
            Access token
            <input
              type="password"
              value={proxyToken}
              placeholder="The Worker's PROXY_TOKEN"
              autoComplete="off"
              onChange={(e) => setProxyToken(e.target.value.trim())}
            />
            <button type="button" className={styles.button} onClick={() => setShowSettings(false)}>
              Done
            </button>
          </label>
        </>
      ) : (
        <div className={styles.settings}>
          <button type="button" className={styles.button} onClick={() => setShowSettings(true)}>
            Settings
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={handleClear}
            disabled={busy || lines.length === 0}
          >
            New chat
          </button>
        </div>
      )}
    </div>
  );

  const footer = (
    <form className={styles.form} onSubmit={handleSubmit}>
      <input
        type="text"
        value={input}
        autoFocus
        placeholder={pending ? 'Confirm or cancel the action above' : 'Ask about your gear…'}
        onChange={(e) => setInput(e.target.value)}
        disabled={busy || Boolean(pending)}
      />
      <button
        type="submit"
        className={styles.primaryButton}
        disabled={busy || Boolean(pending) || !input.trim()}
      >
        {busy ? 'Thinking…' : 'Send'}
      </button>
    </form>
  );

  return (
    <Sheet
      onClose={() => setOpen(false)}
      header={header}
      footer={footer}
      sheetClassName={styles.sheet}
    >
      <div className={styles.messages}>
        {lines.length === 0 && (
          <div className={styles.empty}>
            Try "What's my highest power Void rocket launcher?" or "Equip max power on my Titan".
            Anything that moves or changes gear asks you to confirm first.
          </div>
        )}
        {lines.map((line, i) => (
          <div key={i} className={lineClassNames[line.kind]}>
            {line.text}
          </div>
        ))}
        {pending && (
          <div className={styles.pending}>
            <div>{pending.summary}</div>
            <div className={styles.pendingButtons}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => handleResolve(true)}
                disabled={busy}
              >
                Confirm
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => handleResolve(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </Sheet>
  );
}
