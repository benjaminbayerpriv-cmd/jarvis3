package dev.jarvis.mobile

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@Composable
fun QrCamera(onCode: (String) -> Unit, onError: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val delivery by rememberUpdatedState(onCode)
    val failure by rememberUpdatedState(onError)
    val view = remember { PreviewView(context) }
    DisposableEffect(view, lifecycle) {
        val main = ContextCompat.getMainExecutor(context)
        val worker = Executors.newSingleThreadExecutor()
        val done = AtomicBoolean(false)
        val provider = ProcessCameraProvider.getInstance(context)
        val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
        val analyzer = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        analyzer.setAnalyzer(worker) { image ->
            try {
                if (!done.get()) {
                    val y = image.planes[0]
                    val bytes = ByteArray(y.buffer.remaining()).also { y.buffer.get(it) }
                    val required = y.rowStride * image.height
                    val source = PlanarYUVLuminanceSource(bytes.copyOf(required), y.rowStride, image.height,
                        0, 0, image.width, image.height, false)
                    val code = runCatching { QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source))).text }.getOrNull()
                    if (code != null && done.compareAndSet(false, true)) main.execute { delivery(code) }
                }
            } finally { image.close() }
        }
        provider.addListener({
            if (!done.get()) runCatching {
                provider.get().bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analyzer)
            }.onFailure { failure("Kamera konnte nicht gestartet werden.") }
        }, main)
        onDispose {
            done.set(true)
            analyzer.clearAnalyzer()
            if (provider.isDone) runCatching { provider.get().unbind(preview, analyzer) }
            worker.shutdown()
        }
    }
    AndroidView({ view }, Modifier.fillMaxWidth().height(300.dp))
}
