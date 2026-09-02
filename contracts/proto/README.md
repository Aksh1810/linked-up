# Shared Protocol Buffer contracts

`linked_up/match/v1` is the import root for the versioned ASP.NET-to-C++ match
orchestration contract. Field numbers are append-only: never renumber or reuse
an assigned field number.

C# generation uses `Grpc.Tools`; C++ generation runs into the CMake build
output, not this source tree. Do not log, persist, or place a raw
`PlayerLaunch.ticket` in public room messages.
