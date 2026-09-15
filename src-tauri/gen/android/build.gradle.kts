buildscript {
    /* 国内本地构建走阿里云镜像加速；CI（GitHub Actions 注入 CI=true）直连官方源——
       镜像在美国节点会间歇性 502，Gradle 对服务器错误不做仓库回退，直接判定解析失败 */
    val useAliyunMirror = System.getenv("CI") == null
    repositories {
        if (useAliyunMirror) {
            maven { url = uri("https://maven.aliyun.com/repository/google") }
            maven { url = uri("https://maven.aliyun.com/repository/central") }
            maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        }
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    val useAliyunMirror = System.getenv("CI") == null
    repositories {
        if (useAliyunMirror) {
            maven { url = uri("https://maven.aliyun.com/repository/google") }
            maven { url = uri("https://maven.aliyun.com/repository/central") }
        }
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}
