// User interactions and process-to-process persistence for phone layouts.
// Copyright (C) 2026 WideMelon contributors
// SPDX-License-Identifier: GPL-3.0-or-later
#include "frontend/qt_sdl/PhoneBridge.h"
#include "frontend/qt_sdl/PhoneLayoutDialog.h"

#include <QApplication>
#include <QCheckBox>
#include <QDialogButtonBox>
#include <QDoubleSpinBox>
#include <QFile>
#include <QProcess>
#include <QProcessEnvironment>
#include <QPushButton>
#include <QSplitter>
#include <QTemporaryDir>
#include <QTest>
#include <stdio.h>

#define CHECK(condition) do { if (!(condition)) { \
    fprintf(stderr, "Layout line %d: %s\n", __LINE__, #condition); return 1; } } while (false)

namespace
{
PhoneControllerLayout fixture()
{
    auto layout = PhoneControllerLayout::defaults();
    layout.items[3].appearance = "analog";
    PhoneLayoutItem action;
    action.id = "custom-pause";
    action.label = "Pause";
    action.hotkey = PhoneLayoutHotkeyActions().first().id;
    action.removable = true;
    action.rect = QRectF(.8, .7, .1, .1);
    layout.items.append(action);
    return layout;
}

QRect itemBounds(QWidget* canvas, const PhoneLayoutItem& item)
{
    // Map the normalized layout onto the editor's 900:420 preview.
    QRect area = canvas->rect().adjusted(14, 14, -14, -14);
    QSize size(900, 420);
    size.scale(area.size(), Qt::KeepAspectRatio);
    const QPointF origin = QRectF(area).center() - QPointF(size.width(), size.height()) / 2;
    return QRectF(origin + QPointF(item.rect.x() * size.width(), item.rect.y() * size.height()),
        QSizeF(item.rect.width() * size.width(), item.rect.height() * size.height())).toRect();
}

void drag(QWidget* canvas, const QPoint& start, const QPoint& delta)
{
    QTest::mousePress(canvas, Qt::LeftButton, Qt::NoModifier, start);
    QTest::mouseMove(canvas, start + delta);
    QTest::mouseRelease(canvas, Qt::LeftButton, Qt::NoModifier, start + delta);
}
}

int TestPhoneLayout(QApplication& application)
{
    const QStringList args = application.arguments();
    if (args.contains("--layout-persistence"))
    {
        QTemporaryDir directory;
        CHECK(directory.isValid());
        // Each child starts with empty process memory and reads the same TOML
        // file. Never use the user's WideMelon configuration directory.
        for (const QString& mode : {"--layout-save", "--layout-reopen", "--layout-shown"})
        {
            QProcess child;
            auto environment = QProcessEnvironment::systemEnvironment();
            environment.insert("WIDEMELON_PHONE_TEST_CONFIG_DIR", directory.path());
            child.setProcessEnvironment(environment);
            child.start(QCoreApplication::applicationFilePath(), {mode});
            CHECK(child.waitForStarted());
            CHECK(child.waitForFinished(10000));
            fprintf(stderr, "%s", child.readAllStandardError().constData());
            CHECK(child.exitStatus() == QProcess::NormalExit && child.exitCode() == 0);
            QFile saved(directory.filePath("melonDS.toml"));
            CHECK(saved.open(QIODevice::ReadOnly) && saved.readAll().contains("showDsControls"));
        }
        return 0;
    }

    PhoneBridgeManager bridge;
    auto expected = fixture();
    const bool reopening = args.contains("--layout-reopen") || args.contains("--layout-shown");
    if (reopening)
    {
        expected.showDsControls = args.contains("--layout-shown");
        CHECK(bridge.settings().layoutJson == expected.toJson());
    }
    else
    {
        auto settings = bridge.settings();
        settings.layoutJson = expected.toJson();
        bridge.setSettings(settings);
    }

    PhoneLayoutDialog editor(&bridge);
    editor.setAttribute(Qt::WA_DeleteOnClose, false);
    editor.show();
    editor.activateWindow();
    CHECK(QTest::qWaitForWindowActive(&editor));
    auto toggle = editor.findChild<QCheckBox*>("showDsControls");
    auto buttons = editor.findChild<QDialogButtonBox*>();
    CHECK(toggle && buttons && toggle->isChecked() == expected.showDsControls);
    auto clickToggle = [&] {
        QTest::mouseClick(toggle, Qt::LeftButton, Qt::NoModifier, QPoint(8, toggle->height() / 2));
    };
    if (args.contains("--layout-shown")) return 0;
    if (args.contains("--layout-save") || args.contains("--layout-reopen"))
    {
        clickToggle();
        expected.showDsControls = !expected.showDsControls;
        CHECK(toggle->isChecked() == expected.showDsControls);
        QTest::mouseClick(buttons->button(QDialogButtonBox::Save), Qt::LeftButton);
        CHECK(!editor.isVisible() && bridge.settings().layoutJson == expected.toJson());
        return 0;
    }

    CHECK(args.contains("--layout-editor"));
    auto splitter = editor.findChild<QSplitter*>();
    CHECK(splitter);
    QWidget* canvas = splitter->widget(0);
    const auto spins = editor.findChildren<QDoubleSpinBox*>();
    CHECK(canvas && spins.size() == 4);
    QPushButton* apply = nullptr;
    for (QPushButton* button : buttons->findChildren<QPushButton*>())
        if (buttons->buttonRole(button) == QDialogButtonBox::ApplyRole) apply = button;
    CHECK(apply);

    // Every built-in control is selectable while shown. Hiding a selected
    // control must immediately disable its geometry inspector.
    for (int index = 1; index < 7; index++)
    {
        QTest::mouseClick(canvas, Qt::LeftButton, Qt::NoModifier, itemBounds(canvas, expected.items[index]).center());
        CHECK(spins.first()->isEnabled());
        clickToggle();
        CHECK(!toggle->isChecked());
        for (auto spin : spins) CHECK(!spin->isEnabled());
        clickToggle();
        CHECK(toggle->isChecked());
    }
    clickToggle();
    expected.showDsControls = false;
    for (int index = 1; index < 7; index++)
    {
        const QRect bounds = itemBounds(canvas, expected.items[index]);
        for (const QPoint& start : {bounds.center(), bounds.bottomRight()})
        {
            drag(canvas, start, QPoint(12, -8));
            for (auto spin : spins) CHECK(!spin->isEnabled());
            QTest::mouseClick(apply, Qt::LeftButton);
            CHECK(bridge.settings().layoutJson == expected.toJson());
        }
    }

    // Positive controls: screen and custom action can still be moved. Actual
    // key events restore the layout, rather than invoking shortcut signals.
    for (int index : {0, 7})
    {
        drag(canvas, itemBounds(canvas, expected.items[index]).center(), QPoint(12, -8));
        CHECK(spins.first()->isEnabled());
        QTest::mouseClick(apply, Qt::LeftButton);
        const auto moved = PhoneControllerLayout::fromJson(bridge.settings().layoutJson);
        CHECK(moved.items[index].rect != expected.items[index].rect);
        for (int hidden = 1; hidden < 7; hidden++) CHECK(moved.items[hidden].rect == expected.items[hidden].rect);
        canvas->setFocus();
        QTest::keySequence(canvas, QKeySequence::Undo);
        QTest::mouseClick(apply, Qt::LeftButton);
        CHECK(bridge.settings().layoutJson == expected.toJson());
        canvas->setFocus();
        QTest::keySequence(canvas, QKeySequence::Redo);
        QTest::mouseClick(apply, Qt::LeftButton);
        CHECK(bridge.settings().layoutJson == moved.toJson());
        canvas->setFocus();
        QTest::keySequence(canvas, QKeySequence::Undo);
    }
    clickToggle();
    expected.showDsControls = true;
    QTest::mouseClick(apply, Qt::LeftButton);
    CHECK(bridge.settings().layoutJson == expected.toJson());
    printf("Phone layout mouse interactions, hidden hit targets and keyboard undo/redo passed\n");
    return 0;
}
