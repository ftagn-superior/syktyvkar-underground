# SFX by Kenney — CC0

The 17 short mono PCM16 WAV files in this directory are the MVP game sound bank.
They are served locally with the application; no third-party audio requests occur in gameplay.

Original packs:

- Impact Sounds: https://kenney.nl/assets/impact-sounds
- Interface Sounds: https://kenney.nl/assets/interface-sounds

The accompanying license texts are preserved from the downloaded packs. `provenance.json`
records the original authorship, public mirror used for retrieval, source hash, and shipped
file hash. The mirror archives were not compared byte-for-byte with the Kenney downloads.

Processing: decode to 44,100 Hz PCM16 WAV; average stereo channels to mono; no trimming,
normalization or gain applied. Runtime gain and variation live in `src/audio/policy.ts`.
The three optional grass recordings from the audition bank are intentionally not shipped.
