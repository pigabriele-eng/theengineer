// A way to the Seasons page: this year's seasons by name, or an offer to make one, as a text link.
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { TextLink } from '@/components/Programme';
import { Season, seasonsApi } from '@/lib/seasons';

export function SeasonsLink() {
  const [seasons, setSeasons] = useState<Season[] | null>(null);
  useFocusEffect(useCallback(() => {
    seasonsApi.list().then(setSeasons, () => setSeasons(null)); // an older server: no link
  }, []));
  if (!seasons) return null;
  const year = new Date().getFullYear();
  const now = seasons.filter((s) => s.year >= year);
  const words = now.length ? `Seasons: ${now.map((s) => s.name).join(', ')}` : 'Make this year’s season';
  return <TextLink href="/seasons" label={words} arrow small />;
}
