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

### barcelona.jpg

- What: Barcelona-Catalunya.
- Source: https://commons.wikimedia.org/wiki/File:Barcelona,_Circuit_de_Catalunya_(Ank_kumar)_03.jpg
- Author: Ank Kumar
- Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 4.0.
- Credit shown: "Photo: Ank Kumar / Wikimedia Commons, CC BY-SA 4.0, cropped"

### brands-hatch.jpg

- What: Brands Hatch.
- Source: https://commons.wikimedia.org/wiki/File:Brands_Hatch_Sheene_Curve_2018_(45518207712).jpg
- Author: mattbuck (https://www.flickr.com/photos/mattbuck007/)
- Licence: CC BY-SA 2.0 (https://creativecommons.org/licenses/by-sa/2.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 2.0.
- Credit shown: "Photo: mattbuck (https://www.flickr.com/photos/mattbuck007/) / Wikimedia Commons, CC BY-SA 2.0, cropped"

### imola.jpg

- What: Imola.
- Source: https://commons.wikimedia.org/wiki/File:WTCC08_Dino_ed_Enzo_Ferrari_Circuit_Imola.jpg
- Author: Grantuking
- Licence: CC BY 2.0 (https://creativecommons.org/licenses/by/2.0)
- Changes: downsized.
- Credit shown: "Photo: Grantuking / Wikimedia Commons, CC BY 2.0"

### jeddah.jpg

- What: Jeddah Corniche Circuit (no free photo of the circuit: the default photo).
- Source: https://commons.wikimedia.org/wiki/File:Backplate_%E2%80%93_Zwartkops_Curve_Sunset_(Dimitrios_Savva_and_Jarod_Guest_via_Poly_Haven)_39.jpg
- Author: Dimitrios Savva and Jarod Guest via Poly Haven
- Licence: CC0 (http://creativecommons.org/publicdomain/zero/1.0/)
- Credit shown: "Photo: Dimitrios Savva and Jarod Guest via Poly Haven / Wikimedia Commons, CC0"

### lausitzring.jpg

- What: Lausitzring.
- Source: https://commons.wikimedia.org/wiki/File:Lausitzring_bladenight_aug2017_(11).jpg
- Author: Z thomas
- Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 4.0.
- Credit shown: "Photo: Z thomas / Wikimedia Commons, CC BY-SA 4.0, cropped"

### magny-cours.jpg

- What: Magny-Cours.
- Source: https://commons.wikimedia.org/wiki/File:Circuit_de_Nevers_Magny-Cours-Northeast_side.jpg
- Author: Cjp24
- Licence: CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 3.0.
- Credit shown: "Photo: Cjp24 / Wikimedia Commons, CC BY-SA 3.0, cropped"

### misano.jpg

- What: Misano.
- Source: https://commons.wikimedia.org/wiki/File:2007-08-26_Curva_della_quercia_del_Misano_World_Circuit_(Misano_Adriatico).jpg
- Author: Enrico Siboni
- Licence: CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 3.0.
- Credit shown: "Photo: Enrico Siboni / Wikimedia Commons, CC BY-SA 3.0, cropped"

### monza.jpg

- What: Monza.
- Source: https://commons.wikimedia.org/wiki/File:Autodromo_Nazionale_di_Monza,_first_chicane_-_Flickr_-_crash71100.jpg
- Author: crash71100
- Licence: CC0 (http://creativecommons.org/publicdomain/zero/1.0/)
- Credit shown: "Photo: crash71100 / Wikimedia Commons, CC0 (no attribution required)"

### norisring.jpg

- What: Norisring.
- Source: https://commons.wikimedia.org/wiki/File:2019_Norisring_Speedweekend_-_Racetrack_03.jpg
- Author: NaBUru38
- Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 4.0.
- Credit shown: "Photo: NaBUru38 / Wikimedia Commons, CC BY-SA 4.0, cropped"

### nurburgring.jpg

- What: Nürburgring.
- Source: https://commons.wikimedia.org/wiki/File:ADAC_GT_Masters_at_Nuerburgring.jpg
- Author: Herranderssvensson
- Licence: CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 3.0.
- Credit shown: "Photo: Herranderssvensson / Wikimedia Commons, CC BY-SA 3.0, cropped"

### oschersleben.jpg

- What: Oschersleben.
- Source: https://commons.wikimedia.org/wiki/File:2025-04-25_Motorsport,_DTM,_Oschersleben_STP_2726.jpg
- Author: Steffen Prößdorf
- Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 4.0.
- Credit shown: "Photo: Steffen Prößdorf / Wikimedia Commons, CC BY-SA 4.0, cropped"

### paul-ricard.jpg

- What: Circuit Paul Ricard.
- Source: https://commons.wikimedia.org/wiki/File:Circuit_Paul_Ricard_(54732914592).jpg
- Author: crash71100
- Licence: CC0 (http://creativecommons.org/publicdomain/zero/1.0/)
- Credit shown: "Photo: crash71100 / Wikimedia Commons, CC0 (no attribution required)"

### portimao.jpg

- What: Portimão (Algarve).
- Source: https://commons.wikimedia.org/wiki/File:Aut%C3%B3dromo_Internacional_do_Algarve_(2012-09-23),_by_Klugschnacker_in_Wikipedia_(11).JPG
- Author: Klugschnacker
- Licence: CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 3.0.
- Credit shown: "Photo: Klugschnacker / Wikimedia Commons, CC BY-SA 3.0, cropped"

### red-bull-ring.jpg

- What: Red Bull Ring.
- Source: https://commons.wikimedia.org/wiki/File:Luftaufnahme_(c)Red_Bull_Ring.jpg
- Author: Vanessa Machelett
- Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 4.0.
- Credit shown: "Photo: Vanessa Machelett / Wikimedia Commons, CC BY-SA 4.0, cropped"

### sachsenring.jpg

- What: Sachsenring.
- Source: https://commons.wikimedia.org/wiki/File:Sachsenring._Von_Oben_gesehen._origWI.jpg
- Author: Kora27
- Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 4.0.
- Credit shown: "Photo: Kora27 / Wikimedia Commons, CC BY-SA 4.0, cropped"

### salzburgring.jpg

- What: Salzburgring.
- Source: https://commons.wikimedia.org/wiki/File:Mercedes-Benz_Classic_Days_Salzburg_2006_-_Salzburgring_(07).jpg
- Author: Bahnfrend
- Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 4.0.
- Credit shown: "Photo: Bahnfrend / Wikimedia Commons, CC BY-SA 4.0, cropped"

### silverstone.jpg

- What: Silverstone.
- Source: https://commons.wikimedia.org/wiki/File:National_circuit_pitlane_at_Silverstone_-_geograph.org.uk_-_8161533.jpg
- Author: TCExplorer
- Licence: CC BY-SA 2.0 (https://creativecommons.org/licenses/by-sa/2.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 2.0.
- Credit shown: "Photo: TCExplorer / Wikimedia Commons, CC BY-SA 2.0, cropped"

### spa.jpg

- What: Spa-Francorchamps.
- Source: https://commons.wikimedia.org/wiki/File:Circuit_de_Spa-Francorchamps_03.jpg
- Author: FrDr
- Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 4.0.
- Credit shown: "Photo: FrDr / Wikimedia Commons, CC BY-SA 4.0, cropped"

### valencia.jpg

- What: Valencia (Ricardo Tormo).
- Source: https://commons.wikimedia.org/wiki/File:Salida_Clio_Cup_Europe_2021.jpg
- Author: Sentoan
- Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0)
- Changes: downsized, and shown cropped to fill each page's photo frame. The modified file stays under CC BY-SA 4.0.
- Credit shown: "Photo: Sentoan / Wikimedia Commons, CC BY-SA 4.0, cropped"

## Fonts

Loaded from the @expo-google-fonts packages (node_modules), each under the SIL Open Font License 1.1
(https://openfontlicense.org). The licence text ships in each package's LICENSE_FONT file.

- Anton: Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont). Headlines and very large
  figures.
- Newsreader: Copyright 2020 The Newsreader Project Authors (https://github.com/productiontype/Newsreader). Reading text.
- Archivo Narrow: Copyright 2019 The Archivo Narrow Project Authors (https://github.com/Omnibus-Type/ArchivoNarrow).
  Labels, navigation and numbers in tables.
- Space Mono (assets/fonts/SpaceMono-Regular.ttf): Copyright 2016 Google Inc., SIL Open Font License 1.1.
