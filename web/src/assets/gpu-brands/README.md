# GPU identity marks

The NVIDIA, AMD, and Intel SVGs are copied without geometry changes from
[Simple Icons](https://github.com/simple-icons/simple-icons/tree/7f18aaa676087b8240b6f4ff58a6720be282da59/icons),
revision `7f18aaa676087b8240b6f4ff58a6720be282da59`. `paths.ts` contains their
unchanged path data for local inline rendering. Nothing is downloaded at runtime.
The Simple Icons [CC0 1.0 notice](./LICENSE.simple-icons.md) is included here.

The graphics identify observed hardware in Leviathan. They do not indicate
endorsement, GPU health, or allocation availability. NVIDIA uses Leviathan's
existing theme-aware green; AMD and Intel use the theme foreground.

Brand references:

- [NVIDIA logo media assets](https://nvidianews.nvidia.com/multimedia/corporate/nvidia-logos)
- [AMD brand media library](https://newsroom.amd.com/media-center/)
- [Intel trademarks and brands](https://www.intel.com/content/www/us/en/legal/trademarks.html)

NVIDIA and the NVIDIA logo are trademarks of NVIDIA Corporation. AMD and the
AMD logo are trademarks of Advanced Micro Devices, Inc. Intel and the Intel
logo are trademarks of Intel Corporation or its subsidiaries. The CC0 notice
does not grant trademark rights.

Vendor resolution uses explicit device-name tokens or established GPU product
families. Empty, conflicting, or unknown names use the generic GPU symbol. A
mixed or partly unidentified inventory also uses the generic symbol. MIG
instances receive the identity of their physical GPU; UUIDs, PCI bus addresses,
and driver capabilities are not used to guess a vendor. This feature does not
add AMD or Intel collectors.
