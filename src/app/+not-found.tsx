// A link into the app that names no screen (an old or mistyped necreader://
// link): the app's own page with a way to the library, instead of the
// router's "Unmatched Route" page in its default colours.

import { Stack, router } from 'expo-router';
import { ErrorScreen } from '@/ui/ErrorScreen';

export default function NotFound() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Back to the library under this page (see the root layout's anchor), or to a new one. */}
      <ErrorScreen title="Nothing here" message="This link doesn’t lead to anything in the app." actions={[{ label: 'Go to the library', onPress: () => router.dismissTo('/'), primary: true }]} />
    </>
  );
}
