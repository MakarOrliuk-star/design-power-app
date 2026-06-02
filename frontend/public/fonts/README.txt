Circular font files go here (served from /fonts/...).

Expected files (referenced by app/assets/css/main.css @font-face):
  - CircularStd-Book.woff2   / CircularStd-Book.woff    (weight 450)
  - CircularStd-Medium.woff2 / CircularStd-Medium.woff  (weight 500)
  - CircularStd-Bold.woff2   / CircularStd-Bold.woff    (weight 700)

Circular is a proprietary typeface (Lineto) and is not bundled in the repo.
Until these files are added, the fallback chain in --font-sans renders
(Nunito Sans / system rounded grotesque).
