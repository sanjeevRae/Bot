import Engagement from '../components/Engagement';

/**
 * /inbox — kept as a working URL. The Inbox now lives in the Engagement page, so
 * this route opens Engagement with the Inbox tab already selected.
 */
export default function InboxPage() {
  return <Engagement initialTab="inbox" />;
}