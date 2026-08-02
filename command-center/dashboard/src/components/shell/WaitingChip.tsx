/**
 * WaitingChip — the real, global "a session is waiting on you" indicator (feat-live-visibility,
 * Gap A: "a waiting question is invisible outside its own conversation").
 *
 * Mounted in the Topbar (present on every route via AppShell), next to the existing
 * `ClaudeCodeChip` — the same "small, honest, always-reachable chip" surface that chip already
 * establishes, rather than a new fixed-position overlay corner. Renders NOTHING when there is no
 * genuinely pending ask (mirrors `ConnectionBanner`'s "healthy state has no chrome" convention) —
 * this must never claim a wait that isn't real, and must never hide one that is.
 *
 * SCOPE: the ACTIVE project only — see `gateway-pending-asks.ts`'s own header for why. Clicking
 * jumps straight to the conversation that asked (the FIRST pending ask when more than one
 * conversation in this project is genuinely waiting at once).
 */

import { useNavigate } from 'react-router-dom';

import { Icon, Machine } from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import { useGatewayPendingAsks } from '@/prototype/state/gateway-pending-asks';

import './waiting-chip.css';

export function WaitingChip() {
  const { state, dispatch } = usePrototype();
  const navigate = useNavigate();
  const pending = useGatewayPendingAsks(state.activeProjectId);

  if (pending.length === 0) return null;

  const first = pending[0];
  const more = pending.length - 1;
  const excerpt = first.conversationFirstMessage;
  const title =
    (excerpt !== null ? `Waiting on you: "${excerpt}"` : 'Waiting on you for a question with no message text yet') +
    (more > 0 ? ` (+${more} more conversation${more === 1 ? '' : 's'} also waiting)` : '');

  function jumpToConversation() {
    dispatch({ type: 'conversation/activate', id: first.conversationId });
    navigate('/chat');
  }

  return (
    <button type="button" className="fw-waiting" onClick={jumpToConversation} title={title}>
      <Icon name="MessageSquare" size="xs" className="fw-waiting__icon" />
      <Machine className="fw-waiting__text">
        <span className="fw-waiting__part">Waiting on you</span>
        {pending.length > 1 ? <span className="fw-waiting__count">{pending.length}</span> : null}
      </Machine>
    </button>
  );
}

export default WaitingChip;
