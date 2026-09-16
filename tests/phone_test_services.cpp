// Temporary file-system boundary; tests use the production TOML configuration.
// Copyright (C) 2026 WideMelon contributors
// SPDX-License-Identifier: GPL-3.0-or-later
#include "Platform.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QTemporaryDir>

namespace melonDS::Platform
{
std::string GetLocalFilePath(const std::string& filename)
{
    static QTemporaryDir temporary;
    const QString directory = qEnvironmentVariable("WIDEMELON_PHONE_TEST_CONFIG_DIR", temporary.path());
    const QString name = QString::fromStdString(filename);
    if (!temporary.isValid() || !QDir(directory).exists() || QFileInfo(name).fileName() != name)
        qFatal("Invalid test configuration path");
    return QDir(directory).filePath(name).toStdString();
}

bool CheckFileWritable(const std::string& path)
{
    QFile file(QString::fromStdString(path));
    return file.open(QIODevice::WriteOnly | QIODevice::Append);
}

bool FileExists(const std::string& path)
{
    return QFileInfo::exists(QString::fromStdString(path));
}

// Only the legacy reader needs these file operations; all test writes go
// through Config::Save and its real TOML serializer.
struct FileHandle { QFile file; };

FileHandle* OpenLocalFile(const std::string& path, FileMode mode)
{
    if (mode != FileMode::ReadText) qFatal("Unexpected test file mode");
    auto handle = new FileHandle;
    handle->file.setFileName(QString::fromStdString(GetLocalFilePath(path)));
    if (handle->file.open(QIODevice::ReadOnly | QIODevice::Text)) return handle;
    delete handle;
    return nullptr;
}

bool CloseFile(FileHandle* handle)
{
    handle->file.close();
    delete handle;
    return true;
}

bool IsEndOfFile(FileHandle* handle) { return handle->file.atEnd(); }
bool FileReadLine(char* line, int count, FileHandle* handle)
{
    return handle->file.readLine(line, count) > 0;
}
}
