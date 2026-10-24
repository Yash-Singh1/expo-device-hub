---
"expo-device-hub": patch
---

Prevent roughly three seconds of iOS Simulator preview lag in the Hub by keeping serve-sim's low-latency encoding enabled after successful frame drops.
