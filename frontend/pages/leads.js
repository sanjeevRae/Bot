import Engagement from '../components/Engagement';

/**
 * /leads — kept as a working URL. Leads now live in the Engagement page, so this
 * route opens Engagement with the Leads tab already selected.
 */
export default function LeadsPage() {
  return <Engagement initialTab="leads" />;
}