# Credits: photos and fonts

The app shows each photo's credit on screen where the photo is (top-right corner of a page's photo, or the caption under
a framed picture). Tapping the credit opens the photo's page.

## Photos (assets/images/tracks)

One photo per track, named by its venue key (lib/venues.ts), plus default.jpg for a track without one. They are made
by `npm run track-photos` (scripts/track-photos.mjs) from the photo list tracks.json: each downsized to at most 1600 px
wide and compressed to under about 300 KB. The script also writes constants/trackPhotos.ts with each credit, adding
"cropped" to a CC BY-SA credit. Add a track's entry here when you add its photo.

### hockenheim.jpg

- What: Hockenheimring, main grandstands along the start/finish straight (2010).
- Source: https://commons.wikimedia.org/wiki/File:Hockenheimring_start-ziel-gerade_2010.jpg
- Author: Kmtextor
- Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 4.0.
- Credit shown: "Photo: Kmtextor / Wikimedia Commons, CC BY-SA 4.0, cropped"

### default.jpg

- What: Zwartkops Raceway, low sun over an empty corner.
- Source: https://commons.wikimedia.org/wiki/File:Backplate_%E2%80%93_Zwartkops_Curve_Sunset_(Dimitrios_Savva_and_Jarod_Guest_via_Poly_Haven)_39.jpg
- Author: Dimitrios Savva (photography), Jarod Guest (processing), via Poly Haven
- Licence: CC0 (http://creativecommons.org/publicdomain/zero/1.0/); no attribution required, credited anyway.
- Credit shown: "Photo: Dimitrios Savva and Jarod Guest via Poly Haven / Wikimedia Commons, CC0"

### zandvoort.jpg

- What: Circuit Zandvoort from the air.
- Source: https://commons.wikimedia.org/wiki/File:Aerial_view_of_Motorsport_race_track_Circuit_Zandvoort_Formula_one_(40889997713).jpg
- Author: dronepicr
- Licence: CC BY 2.0 (https://creativecommons.org/licenses/by/2.0)
- Changes: downsized.
- Credit shown: "Photo: dronepicr / Wikimedia Commons, CC BY 2.0"

## Fonts

Loaded from the @expo-google-fonts packages (node_modules), each under the SIL Open Font License 1.1
(https://openfontlicense.org). The licence text ships in each package's LICENSE_FONT file.

- Anton: Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont). Headlines and very large
  figures.
- Newsreader: Copyright 2020 The Newsreader Project Authors (https://github.com/productiontype/Newsreader). Reading text.
- Archivo Narrow: Copyright 2019 The Archivo Narrow Project Authors (https://github.com/Omnibus-Type/ArchivoNarrow).
  Labels, navigation and numbers in tables.
- Space Mono (assets/fonts/SpaceMono-Regular.ttf): Copyright 2016 Google Inc., SIL Open Font License 1.1.
