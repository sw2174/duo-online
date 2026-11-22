#!/bin/sh
# Blok Yarışı - Android/Java build ortam değişkenleri.
# Kullanmak için: source android-sdk-env.sh
export JAVA_HOME="$HOME/Library/Java/JavaVirtualMachines/temurin21"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
