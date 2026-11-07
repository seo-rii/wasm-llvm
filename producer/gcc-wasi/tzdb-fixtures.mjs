// GNU C++20 timezone API cases. Expectations were independently computed from
// the pinned TZif snapshots for 2024; metadata and leap cases test GNU 2026b
// source contracts. Merely importing these fixtures does not qualify a compiler.
export const timezoneCases = [
  {
    "id": "tzdb-metadata-o0",
    "family": "metadata",
    "request": {
      "language": "cpp",
      "standard": "c++20",
      "optimization": "0",
      "code": "#include <chrono>\n#include <cstdio>\n#include <string>\n#include <stdexcept>\nusing namespace std::chrono;\n\nint main() {\n  const auto& db = get_tzdb();\n  auto& list = get_tzdb_list();\n  unsigned before=0; for (const auto& ignored:list) { (void)ignored; ++before; }\n  std::printf(\"version %s %s\\n\",db.version.c_str(),remote_version().c_str());\n  std::printf(\"counts %zu %zu %zu\\n\",db.zones.size(),db.links.size(),db.leap_seconds.size());\n  std::printf(\"identity %d %d\\n\",&db==&list.front(),locate_zone(\"UTC\")==db.locate_zone(\"UTC\"));\n  const auto& reloaded=reload_tzdb();\n  unsigned after=0; for (const auto& ignored:list) { (void)ignored; ++after; }\n  std::printf(\"reload %s %d %u %u\\n\",reloaded.version.c_str(),&reloaded==&db,before,after);\n  const auto* current=current_zone();\n  std::printf(\"current %s %lld\\n\",std::string(current->name()).c_str(),(long long)current->get_info(sys_seconds{}).offset.count());\n}\n"
    },
    "run": {
      "stdin": "",
      "args": []
    },
    "stdout": "version 2026b 2026b\ncounts 341 257 27\nidentity 1 1\nreload 2026b 1 1 1\ncurrent Etc/UTC 0\n",
    "stderr": "",
    "exitCode": 0
  },
  {
    "id": "tzdb-metadata-o2",
    "family": "metadata",
    "request": {
      "language": "cpp",
      "standard": "c++20",
      "optimization": "2",
      "code": "#include <chrono>\n#include <cstdio>\n#include <string>\n#include <stdexcept>\nusing namespace std::chrono;\n\nint main() {\n  const auto& db = get_tzdb();\n  auto& list = get_tzdb_list();\n  unsigned before=0; for (const auto& ignored:list) { (void)ignored; ++before; }\n  std::printf(\"version %s %s\\n\",db.version.c_str(),remote_version().c_str());\n  std::printf(\"counts %zu %zu %zu\\n\",db.zones.size(),db.links.size(),db.leap_seconds.size());\n  std::printf(\"identity %d %d\\n\",&db==&list.front(),locate_zone(\"UTC\")==db.locate_zone(\"UTC\"));\n  const auto& reloaded=reload_tzdb();\n  unsigned after=0; for (const auto& ignored:list) { (void)ignored; ++after; }\n  std::printf(\"reload %s %d %u %u\\n\",reloaded.version.c_str(),&reloaded==&db,before,after);\n  const auto* current=current_zone();\n  std::printf(\"current %s %lld\\n\",std::string(current->name()).c_str(),(long long)current->get_info(sys_seconds{}).offset.count());\n}\n"
    },
    "run": {
      "stdin": "",
      "args": []
    },
    "stdout": "version 2026b 2026b\ncounts 341 257 27\nidentity 1 1\nreload 2026b 1 1 1\ncurrent Etc/UTC 0\n",
    "stderr": "",
    "exitCode": 0
  },
  {
    "id": "tzdb-offsets-o0",
    "family": "offsets",
    "request": {
      "language": "cpp",
      "standard": "c++20",
      "optimization": "0",
      "code": "#include <chrono>\n#include <cstdio>\n#include <string>\n#include <stdexcept>\nusing namespace std::chrono;\n\nint main() {\n  char name[128]; long long value; unsigned i=0;\n  while (std::scanf(\"%127s %lld\",name,&value)==2) {\n    auto* zone=locate_zone(name); auto point=sys_seconds{seconds{value}}; auto info=zone->get_info(point);\n    std::printf(\"offset %u %lld %lld %lld %s\\n\",i++,(long long)info.offset.count(),(long long)info.save.count(),(long long)zone->to_local(point).time_since_epoch().count(),info.abbrev.c_str());\n  }\n}\n"
    },
    "run": {
      "stdin": "UTC 1705320000\nUTC 1721044800\nAmerica/New_York 1705320000\nAmerica/New_York 1721044800\nEurope/Berlin 1705320000\nEurope/Berlin 1721044800\nAustralia/Lord_Howe 1705320000\nAustralia/Lord_Howe 1721044800\nAsia/Seoul 1705320000\nAsia/Seoul 1721044800\nAsia/Kathmandu 1705320000\nAsia/Kathmandu 1721044800\nAmerica/New_York 1710053999\nAmerica/New_York 1710054000\nAmerica/New_York 1710054001\nAmerica/New_York 1730613599\nAmerica/New_York 1730613600\nAmerica/New_York 1730613601\nEurope/Berlin 1711846799\nEurope/Berlin 1711846800\nEurope/Berlin 1711846801\nEurope/Berlin 1729990799\nEurope/Berlin 1729990800\nEurope/Berlin 1729990801\nAustralia/Lord_Howe 1712415599\nAustralia/Lord_Howe 1712415600\nAustralia/Lord_Howe 1712415601\nAustralia/Lord_Howe 1728142199\nAustralia/Lord_Howe 1728142200\nAustralia/Lord_Howe 1728142201\n",
      "args": []
    },
    "stdout": "offset 0 0 0 1705320000 UTC\noffset 1 0 0 1721044800 UTC\noffset 2 -18000 0 1705302000 EST\noffset 3 -14400 60 1721030400 EDT\noffset 4 3600 0 1705323600 CET\noffset 5 7200 60 1721052000 CEST\noffset 6 39600 30 1705359600 +11\noffset 7 37800 0 1721082600 +1030\noffset 8 32400 0 1705352400 KST\noffset 9 32400 0 1721077200 KST\noffset 10 20700 0 1705340700 +0545\noffset 11 20700 0 1721065500 +0545\noffset 12 -18000 0 1710035999 EST\noffset 13 -14400 60 1710039600 EDT\noffset 14 -14400 60 1710039601 EDT\noffset 15 -14400 60 1730599199 EDT\noffset 16 -18000 0 1730595600 EST\noffset 17 -18000 0 1730595601 EST\noffset 18 3600 0 1711850399 CET\noffset 19 7200 60 1711854000 CEST\noffset 20 7200 60 1711854001 CEST\noffset 21 7200 60 1729997999 CEST\noffset 22 3600 0 1729994400 CET\noffset 23 3600 0 1729994401 CET\noffset 24 39600 30 1712455199 +11\noffset 25 37800 0 1712453400 +1030\noffset 26 37800 0 1712453401 +1030\noffset 27 37800 0 1728179999 +1030\noffset 28 39600 30 1728181800 +11\noffset 29 39600 30 1728181801 +11\n",
    "stderr": "",
    "exitCode": 0
  },
  {
    "id": "tzdb-offsets-o2",
    "family": "offsets",
    "request": {
      "language": "cpp",
      "standard": "c++20",
      "optimization": "2",
      "code": "#include <chrono>\n#include <cstdio>\n#include <string>\n#include <stdexcept>\nusing namespace std::chrono;\n\nint main() {\n  char name[128]; long long value; unsigned i=0;\n  while (std::scanf(\"%127s %lld\",name,&value)==2) {\n    auto* zone=locate_zone(name); auto point=sys_seconds{seconds{value}}; auto info=zone->get_info(point);\n    std::printf(\"offset %u %lld %lld %lld %s\\n\",i++,(long long)info.offset.count(),(long long)info.save.count(),(long long)zone->to_local(point).time_since_epoch().count(),info.abbrev.c_str());\n  }\n}\n"
    },
    "run": {
      "stdin": "UTC 1705320000\nUTC 1721044800\nAmerica/New_York 1705320000\nAmerica/New_York 1721044800\nEurope/Berlin 1705320000\nEurope/Berlin 1721044800\nAustralia/Lord_Howe 1705320000\nAustralia/Lord_Howe 1721044800\nAsia/Seoul 1705320000\nAsia/Seoul 1721044800\nAsia/Kathmandu 1705320000\nAsia/Kathmandu 1721044800\nAmerica/New_York 1710053999\nAmerica/New_York 1710054000\nAmerica/New_York 1710054001\nAmerica/New_York 1730613599\nAmerica/New_York 1730613600\nAmerica/New_York 1730613601\nEurope/Berlin 1711846799\nEurope/Berlin 1711846800\nEurope/Berlin 1711846801\nEurope/Berlin 1729990799\nEurope/Berlin 1729990800\nEurope/Berlin 1729990801\nAustralia/Lord_Howe 1712415599\nAustralia/Lord_Howe 1712415600\nAustralia/Lord_Howe 1712415601\nAustralia/Lord_Howe 1728142199\nAustralia/Lord_Howe 1728142200\nAustralia/Lord_Howe 1728142201\n",
      "args": []
    },
    "stdout": "offset 0 0 0 1705320000 UTC\noffset 1 0 0 1721044800 UTC\noffset 2 -18000 0 1705302000 EST\noffset 3 -14400 60 1721030400 EDT\noffset 4 3600 0 1705323600 CET\noffset 5 7200 60 1721052000 CEST\noffset 6 39600 30 1705359600 +11\noffset 7 37800 0 1721082600 +1030\noffset 8 32400 0 1705352400 KST\noffset 9 32400 0 1721077200 KST\noffset 10 20700 0 1705340700 +0545\noffset 11 20700 0 1721065500 +0545\noffset 12 -18000 0 1710035999 EST\noffset 13 -14400 60 1710039600 EDT\noffset 14 -14400 60 1710039601 EDT\noffset 15 -14400 60 1730599199 EDT\noffset 16 -18000 0 1730595600 EST\noffset 17 -18000 0 1730595601 EST\noffset 18 3600 0 1711850399 CET\noffset 19 7200 60 1711854000 CEST\noffset 20 7200 60 1711854001 CEST\noffset 21 7200 60 1729997999 CEST\noffset 22 3600 0 1729994400 CET\noffset 23 3600 0 1729994401 CET\noffset 24 39600 30 1712455199 +11\noffset 25 37800 0 1712453400 +1030\noffset 26 37800 0 1712453401 +1030\noffset 27 37800 0 1728179999 +1030\noffset 28 39600 30 1728181800 +11\noffset 29 39600 30 1728181801 +11\n",
    "stderr": "",
    "exitCode": 0
  },
  {
    "id": "tzdb-local-choices-o0",
    "family": "local-choices",
    "request": {
      "language": "cpp",
      "standard": "c++20",
      "optimization": "0",
      "code": "#include <chrono>\n#include <cstdio>\n#include <string>\n#include <stdexcept>\nusing namespace std::chrono;\n\nint main() {\n  char name[128]; long long value; unsigned i=0;\n  while (std::scanf(\"%127s %lld\",name,&value)==2) {\n    auto* zone=locate_zone(name); auto point=local_seconds{seconds{value}}; auto info=zone->get_info(point);\n    const char* kind=info.result==local_info::unique?\"unique\":info.result==local_info::nonexistent?\"gap\":\"fold\";\n    auto first=info.first.offset.count(),second=info.result==local_info::unique?first:info.second.offset.count();\n    long long end=info.result==local_info::unique?0:info.first.end.time_since_epoch().count();\n    long long begin=info.result==local_info::unique?0:info.second.begin.time_since_epoch().count();\n    std::printf(\"local %u %s %lld %lld %lld %lld %lld %lld\\n\",i++,kind,(long long)first,(long long)second,(long long)zone->to_sys(point,choose::earliest).time_since_epoch().count(),(long long)zone->to_sys(point,choose::latest).time_since_epoch().count(),end,begin);\n  }\n}\n"
    },
    "run": {
      "stdin": "America/New_York 1710037800\nAmerica/New_York 1730597400\nEurope/Berlin 1711852200\nEurope/Berlin 1729996200\nAustralia/Lord_Howe 1712454300\nAustralia/Lord_Howe 1728180900\nUTC 1718452800\nAsia/Seoul 1718452800\nAsia/Kathmandu 1718452800\n",
      "args": []
    },
    "stdout": "local 0 gap -18000 -14400 1710054000 1710054000 1710054000 1710054000\nlocal 1 fold -14400 -18000 1730611800 1730615400 1730613600 1730613600\nlocal 2 gap 3600 7200 1711846800 1711846800 1711846800 1711846800\nlocal 3 fold 7200 3600 1729989000 1729992600 1729990800 1729990800\nlocal 4 fold 39600 37800 1712414700 1712416500 1712415600 1712415600\nlocal 5 gap 37800 39600 1728142200 1728142200 1728142200 1728142200\nlocal 6 unique 0 0 1718452800 1718452800 0 0\nlocal 7 unique 32400 32400 1718420400 1718420400 0 0\nlocal 8 unique 20700 20700 1718432100 1718432100 0 0\n",
    "stderr": "",
    "exitCode": 0
  },
  {
    "id": "tzdb-local-choices-o2",
    "family": "local-choices",
    "request": {
      "language": "cpp",
      "standard": "c++20",
      "optimization": "2",
      "code": "#include <chrono>\n#include <cstdio>\n#include <string>\n#include <stdexcept>\nusing namespace std::chrono;\n\nint main() {\n  char name[128]; long long value; unsigned i=0;\n  while (std::scanf(\"%127s %lld\",name,&value)==2) {\n    auto* zone=locate_zone(name); auto point=local_seconds{seconds{value}}; auto info=zone->get_info(point);\n    const char* kind=info.result==local_info::unique?\"unique\":info.result==local_info::nonexistent?\"gap\":\"fold\";\n    auto first=info.first.offset.count(),second=info.result==local_info::unique?first:info.second.offset.count();\n    long long end=info.result==local_info::unique?0:info.first.end.time_since_epoch().count();\n    long long begin=info.result==local_info::unique?0:info.second.begin.time_since_epoch().count();\n    std::printf(\"local %u %s %lld %lld %lld %lld %lld %lld\\n\",i++,kind,(long long)first,(long long)second,(long long)zone->to_sys(point,choose::earliest).time_since_epoch().count(),(long long)zone->to_sys(point,choose::latest).time_since_epoch().count(),end,begin);\n  }\n}\n"
    },
    "run": {
      "stdin": "America/New_York 1710037800\nAmerica/New_York 1730597400\nEurope/Berlin 1711852200\nEurope/Berlin 1729996200\nAustralia/Lord_Howe 1712454300\nAustralia/Lord_Howe 1728180900\nUTC 1718452800\nAsia/Seoul 1718452800\nAsia/Kathmandu 1718452800\n",
      "args": []
    },
    "stdout": "local 0 gap -18000 -14400 1710054000 1710054000 1710054000 1710054000\nlocal 1 fold -14400 -18000 1730611800 1730615400 1730613600 1730613600\nlocal 2 gap 3600 7200 1711846800 1711846800 1711846800 1711846800\nlocal 3 fold 7200 3600 1729989000 1729992600 1729990800 1729990800\nlocal 4 fold 39600 37800 1712414700 1712416500 1712415600 1712415600\nlocal 5 gap 37800 39600 1728142200 1728142200 1728142200 1728142200\nlocal 6 unique 0 0 1718452800 1718452800 0 0\nlocal 7 unique 32400 32400 1718420400 1718420400 0 0\nlocal 8 unique 20700 20700 1718432100 1718432100 0 0\n",
    "stderr": "",
    "exitCode": 0
  },
  {
    "id": "tzdb-aliases-o0",
    "family": "aliases",
    "request": {
      "language": "cpp",
      "standard": "c++20",
      "optimization": "0",
      "code": "#include <chrono>\n#include <cstdio>\n#include <string>\n#include <stdexcept>\nusing namespace std::chrono;\n\nint main() {\n  char alias[128],canonical[128]; long long value; unsigned i=0;\n  while (std::scanf(\"%127s %127s %lld\",alias,canonical,&value)==3) {\n    auto* zone=locate_zone(alias);\n    std::printf(\"alias %u %s %d %lld\\n\",i++,std::string(zone->name()).c_str(),zone==locate_zone(canonical),(long long)zone->get_info(sys_seconds{seconds{value}}).offset.count());\n  }\n}\n"
    },
    "run": {
      "stdin": "UTC Etc/UTC 1721044800\nUS/Eastern America/New_York 1721044800\nAustralia/LHI Australia/Lord_Howe 1721044800\nAsia/Katmandu Asia/Kathmandu 1721044800\n",
      "args": []
    },
    "stdout": "alias 0 Etc/UTC 1 0\nalias 1 America/New_York 1 -14400\nalias 2 Australia/Lord_Howe 1 37800\nalias 3 Asia/Kathmandu 1 20700\n",
    "stderr": "",
    "exitCode": 0
  },
  {
    "id": "tzdb-aliases-o2",
    "family": "aliases",
    "request": {
      "language": "cpp",
      "standard": "c++20",
      "optimization": "2",
      "code": "#include <chrono>\n#include <cstdio>\n#include <string>\n#include <stdexcept>\nusing namespace std::chrono;\n\nint main() {\n  char alias[128],canonical[128]; long long value; unsigned i=0;\n  while (std::scanf(\"%127s %127s %lld\",alias,canonical,&value)==3) {\n    auto* zone=locate_zone(alias);\n    std::printf(\"alias %u %s %d %lld\\n\",i++,std::string(zone->name()).c_str(),zone==locate_zone(canonical),(long long)zone->get_info(sys_seconds{seconds{value}}).offset.count());\n  }\n}\n"
    },
    "run": {
      "stdin": "UTC Etc/UTC 1721044800\nUS/Eastern America/New_York 1721044800\nAustralia/LHI Australia/Lord_Howe 1721044800\nAsia/Katmandu Asia/Kathmandu 1721044800\n",
      "args": []
    },
    "stdout": "alias 0 Etc/UTC 1 0\nalias 1 America/New_York 1 -14400\nalias 2 Australia/Lord_Howe 1 37800\nalias 3 Asia/Kathmandu 1 20700\n",
    "stderr": "",
    "exitCode": 0
  },
  {
    "id": "tzdb-exceptions-o0",
    "family": "exceptions",
    "request": {
      "language": "cpp",
      "standard": "c++20",
      "optimization": "0",
      "code": "#include <chrono>\n#include <cstdio>\n#include <string>\n#include <stdexcept>\nusing namespace std::chrono;\n\nint main() {\n  char mode[2],name[128]; long long value; unsigned i=0;\n  while (std::scanf(\"%1s %127s %lld\",mode,name,&value)==3) {\n    try {\n      auto* zone=locate_zone(name);\n      if (mode[0]=='L') (void)zone->to_sys(local_seconds{seconds{value}});\n      std::printf(\"error %u unexpected-success\\n\",i++);\n    } catch (const nonexistent_local_time&) { std::printf(\"error %u gap\\n\",i++); }\n      catch (const ambiguous_local_time&) { std::printf(\"error %u fold\\n\",i++); }\n      catch (const std::runtime_error&) { std::printf(\"error %u missing\\n\",i++); }\n  }\n}\n",
      "exceptions": true
    },
    "run": {
      "stdin": "L America/New_York 1710037800\nL America/New_York 1730597400\nL Europe/Berlin 1711852200\nL Europe/Berlin 1729996200\nL Australia/Lord_Howe 1712454300\nL Australia/Lord_Howe 1728180900\nM Invalid/Issue85_Missing 0\n",
      "args": []
    },
    "stdout": "error 0 gap\nerror 1 fold\nerror 2 gap\nerror 3 fold\nerror 4 fold\nerror 5 gap\nerror 6 missing\n",
    "stderr": "",
    "exitCode": 0
  },
  {
    "id": "tzdb-exceptions-o2",
    "family": "exceptions",
    "request": {
      "language": "cpp",
      "standard": "c++20",
      "optimization": "2",
      "code": "#include <chrono>\n#include <cstdio>\n#include <string>\n#include <stdexcept>\nusing namespace std::chrono;\n\nint main() {\n  char mode[2],name[128]; long long value; unsigned i=0;\n  while (std::scanf(\"%1s %127s %lld\",mode,name,&value)==3) {\n    try {\n      auto* zone=locate_zone(name);\n      if (mode[0]=='L') (void)zone->to_sys(local_seconds{seconds{value}});\n      std::printf(\"error %u unexpected-success\\n\",i++);\n    } catch (const nonexistent_local_time&) { std::printf(\"error %u gap\\n\",i++); }\n      catch (const ambiguous_local_time&) { std::printf(\"error %u fold\\n\",i++); }\n      catch (const std::runtime_error&) { std::printf(\"error %u missing\\n\",i++); }\n  }\n}\n",
      "exceptions": true
    },
    "run": {
      "stdin": "L America/New_York 1710037800\nL America/New_York 1730597400\nL Europe/Berlin 1711852200\nL Europe/Berlin 1729996200\nL Australia/Lord_Howe 1712454300\nL Australia/Lord_Howe 1728180900\nM Invalid/Issue85_Missing 0\n",
      "args": []
    },
    "stdout": "error 0 gap\nerror 1 fold\nerror 2 gap\nerror 3 fold\nerror 4 fold\nerror 5 gap\nerror 6 missing\n",
    "stderr": "",
    "exitCode": 0
  },
  {
    "id": "tzdb-leap-cold-model-o0",
    "family": "leap-cold-model",
    "request": {
      "language": "cpp",
      "standard": "c++20",
      "optimization": "0",
      "code": "#include <chrono>\n#include <cstdio>\n#include <string>\n#include <stdexcept>\nusing namespace std::chrono;\n\nint main() {\n  long long value; unsigned i=0;\n  while (std::scanf(\"%lld\",&value)==1) {\n    auto point=utc_seconds{seconds{value}}; auto info=get_leap_second_info(point);\n    std::printf(\"leap %u %d %lld %lld\\n\",i++,info.is_leap_second,(long long)info.elapsed.count(),(long long)utc_clock::to_sys(point).time_since_epoch().count());\n  }\n}\n"
    },
    "run": {
      "stdin": "1798416028\n1798416028\n1893456027\n",
      "args": []
    },
    "stdout": "leap 0 0 27 1798416001\nleap 1 0 27 1798416001\nleap 2 0 27 1893456000\n",
    "stderr": "",
    "exitCode": 0
  },
  {
    "id": "tzdb-leap-cold-model-o2",
    "family": "leap-cold-model",
    "request": {
      "language": "cpp",
      "standard": "c++20",
      "optimization": "2",
      "code": "#include <chrono>\n#include <cstdio>\n#include <string>\n#include <stdexcept>\nusing namespace std::chrono;\n\nint main() {\n  long long value; unsigned i=0;\n  while (std::scanf(\"%lld\",&value)==1) {\n    auto point=utc_seconds{seconds{value}}; auto info=get_leap_second_info(point);\n    std::printf(\"leap %u %d %lld %lld\\n\",i++,info.is_leap_second,(long long)info.elapsed.count(),(long long)utc_clock::to_sys(point).time_since_epoch().count());\n  }\n}\n"
    },
    "run": {
      "stdin": "1798416028\n1798416028\n1893456027\n",
      "args": []
    },
    "stdout": "leap 0 0 27 1798416001\nleap 1 0 27 1798416001\nleap 2 0 27 1893456000\n",
    "stderr": "",
    "exitCode": 0
  }
];
