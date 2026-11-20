plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.streamspace.meetup"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.streamspace.meetup"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        create("meetup") {
            storeFile = file("../meetup-release.jks")
            storePassword = "meetuppermanent"
            keyAlias = "meetup"
            keyPassword = "meetuppermanent"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("meetup")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Intentionally minimal: framework + WebView only, no external libraries.
}
