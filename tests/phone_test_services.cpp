// In-memory configuration and file-path boundary for real bridge tests.
// Copyright (C) 2026 WideMelon contributors
// SPDX-License-Identifier: GPL-3.0-or-later
#include "frontend/qt_sdl/Config.h"
#include "Platform.h"

#include <cstdlib>
#include <map>

namespace Config
{
namespace
{
std::map<std::string, int> integers;
std::map<std::string, bool> booleans;
std::map<std::string, std::string> strings;
}

Table::Table(toml::value& data, const std::string& path) : Data(data), PathPrefix(path) {}
Table GetLocalTable(int)
{
    static toml::value data;
    return Table(data, "");
}
int Table::GetInt(const std::string& key) { return integers[key]; }
bool Table::GetBool(const std::string& key) { return booleans[key]; }
std::string Table::GetString(const std::string& key) { return strings[key]; }
void Table::SetInt(const std::string& key, int value) { integers[key] = value; }
void Table::SetBool(const std::string& key, bool value) { booleans[key] = value; }
void Table::SetString(const std::string& key, const std::string& value) { strings[key] = value; }
void Save() {}
}

namespace melonDS::Platform
{
std::string GetLocalFilePath(const std::string&) { std::abort(); }
}
