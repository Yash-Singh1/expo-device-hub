---
"@expo/serve-sim": patch
"expo-device-hub": patch
---

Prevent roughly three seconds of HTTP simulator preview lag by keeping low-latency encoding enabled after successful frame drops.
