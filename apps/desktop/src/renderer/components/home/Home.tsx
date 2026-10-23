import { useMemo, useState } from 'react';
import { can } from '../../../shared/roles.js';
import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import { ChatComposer } from '../chat/ConversationView.js';
import styles from './home.module.css';

// The home route: a greeting or a needs-you count, plus the chat composer.

// One greeting is picked at random per visit.
export const HOME_GREETINGS = [
  'What are you up to today?',
  'Where should we start?',
  'What shall we build today?',
  "All quiet here. What's on your mind?",
  'Ready when you are.',
] as const;

export function pickGreeting(index: number): string {
  return HOME_GREETINGS[((index % HOME_GREETINGS.length) + HOME_GREETINGS.length) % HOME_GREETINGS.length]!;
}

export function Home() {
  const { orgId, role } = useOrg();
  const [greeting] = useState(() => pickGreeting(Math.floor(Math.random() * HOME_GREETINGS.length)));

  // Needs-you = chats with an open consent gate; the thread list already carries the count.
  const threadsQuery = useQuery('home:threads', () => desk.listThreads(orgId), [orgId]);
  useLive(['threads', 'messages', 'runs'], () => threadsQuery.refetch());

  const needsYouCount = useMemo(
    () => (threadsQuery.data ?? []).filter((t) => t.openGates > 0).length,
    [threadsQuery.data],
  );

  const headline =
    needsYouCount === 0 ? greeting : `${needsYouCount} chat${needsYouCount === 1 ? '' : 's'} need${needsYouCount === 1 ? 's' : ''} you.`;

  return (
    <div className={styles.home}>
      <div className={styles.hz}>{headline}</div>
      {can(role, 'submit') ? (
        <ChatComposer orgId={orgId} threadId={null} role={role} />
      ) : (
        <div className={styles.viewerNote}>viewers can't start new chats — ask an admin</div>
      )}
    </div>
  );
}
