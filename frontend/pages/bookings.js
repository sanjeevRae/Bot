import Engagement from '../components/Engagement';

/**
 * /bookings — kept as a working URL. Bookings now live in the Engagement page, so
 * this route opens Engagement with the Bookings tab already selected.
 */
export default function BookingsPage() {
  return <Engagement initialTab="bookings" />;
}