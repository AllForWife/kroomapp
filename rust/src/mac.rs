//! A Mac's WKWebView: what wry leaves out and the game needs.

use block2::Block;
use objc2::ffi::class_addMethod;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel};
use tauri::WebviewWindow;

/// `-_webViewDidRequestPointerLock:(WKWebView *) completionHandler:(void (^)(BOOL))` (WebKit's private WKUIDelegatePrivate.h): YES grants it.
/// (Not the older `-_webViewRequestPointerLock:`: WebKit calls that one first when a delegate has it, and then still refuses the lock —
/// "Pointer lock requires the window to have focus" — tried on macOS 27.)
extern "C-unwind" fn did_request_pointer_lock(_this: *mut AnyObject, _cmd: Sel, _webview: *mut AnyObject, done: *mut Block<dyn Fn(Bool)>) {
    if let Some(done) = unsafe { done.as_ref() } {
        done.call((Bool::YES,));
    }
}

/// 🖱 Pointer lock for the game's mouse look. WebKit grants `requestPointerLock()` only when the webview's UI delegate answers WebKit's private
/// pointer-lock request (Safari's does; wry's does not), otherwise it refuses every request: the cursor stayed on screen and moving the mouse
/// turned nothing (the game looks around only under pointer lock — src/world/controller.ts). Esc still gives the cursor back (WebKit's own).
/// The method goes onto wry's delegate class, then the delegate is set again: WebKit reads which methods a delegate has when it is set.
pub fn allow_pointer_lock(w: &WebviewWindow) {
    let _ = w.with_webview(|pv| unsafe {
        let wv = pv.inner() as *mut AnyObject;
        if wv.is_null() {
            return;
        }
        let delegate: *mut AnyObject = msg_send![wv, UIDelegate];
        if delegate.is_null() {
            return;
        }
        let cls: &AnyClass = (*delegate).class();
        let sel = sel!(_webViewDidRequestPointerLock:completionHandler:);
        if !cls.responds_to(sel) {
            type F = extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut Block<dyn Fn(Bool)>);
            let imp = std::mem::transmute::<F, Imp>(did_request_pointer_lock);
            if !class_addMethod(cls as *const AnyClass as *mut AnyClass, sel, imp, c"v@:@@?".as_ptr()).as_bool() {
                return;
            }
        }
        let _: () = msg_send![wv, setUIDelegate: delegate];
        crate::mark("pointer lock allowed");
    });
}
