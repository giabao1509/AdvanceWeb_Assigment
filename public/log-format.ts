export interface Trace {
  id:string;service:string;action:string;method:string;path:string;operation_id:string|null;
  request_body:string|null;response_body:string|null;http_status:number|null;transport_error:string|null;
  duration_ms:number|null;started_at:string;complete:number;
}
export interface WorkflowEvent {
  id:string;event:string;status:string;step:string;phase:string;intent:string|null;
  pending:string;error:string|null;created_at:string;
}
export interface ProcessEvent {
  time:string;service:string;event:string;orderId?:string;mode?:string;pid?:number;operationId?:string;
  action?:string;method?:string;path?:string;status?:number;request?:unknown;response?:unknown;
  durationMs?:number;transportError?:string;[key:string]:unknown;
}
export interface LogEntry {
  id:string;time:string;kind:'http'|'workflow'|'service';source:string;title:string;message:string;
  tone:'normal'|'warning'|'error';raw:unknown;trace?:Trace;client?:ProcessEvent;reconciledBy?:Trace;
}
interface LogBody {status?:string;error?:string;action?:string;result?:{error?:string};reservation?:{quantity?:number};payment?:{amount?:number};quantity?:number;amount?:number}
export function parseBody(value:string|null):LogBody {
  try{const parsed=JSON.parse(value || '{}');return parsed && typeof parsed==='object'?parsed:{};}catch{return {};}
}
const actions:Record<string,string>={reserve:'giữ hàng',charge:'thu tiền',refund:'hoàn tiền',release:'trả hàng'};
const money=(value:unknown)=>`${new Intl.NumberFormat('vi-VN').format(Number(value))} ₫`;
const reasons:Record<string,string>={
  INSUFFICIENT_FUNDS:'Ví không đủ số dư.',PAYMENT_DECLINED:'Thanh toán đã bị từ chối.',OUT_OF_STOCK:'Không đủ hàng khả dụng.',
  REFUND_TEMPORARILY_UNAVAILABLE:'Dịch vụ hoàn tiền đang tạm lỗi.',NETWORK_ERROR:'Không kết nối được với service.',TIMEOUT:'Hết thời gian chờ phản hồi.',
  CONFIRM_REJECTED:'Đơn không thể xác nhận sau thanh toán.',IDEMPOTENCY_CONFLICT:'Cùng mã thao tác nhưng nội dung yêu cầu khác nhau.',
};
export function describeTrace(t:Trace,all:Trace[]):LogEntry {
  const action=t.action.split('.')[0];const label=actions[action] || action;const query=t.action.endsWith('.query');
  const body=parseBody(t.response_body);const request=parseBody(t.request_body);
  const reconciledBy=t.operation_id?all.find(other=>other.operation_id===t.operation_id && other.action.endsWith('.query') && other.complete && other.http_status===200 && other.started_at>t.started_at && ['SUCCEEDED','FAILED'].includes(parseBody(other.response_body).status || '')):undefined;
  const entry:LogEntry={id:t.id,time:t.started_at,kind:'http',source:`Order → ${t.service}`,title:`Đã xử lý yêu cầu ${label}`,message:'Kết quả được trả về từ service.',tone:'normal',raw:t,trace:t,reconciledBy};
  if(!t.complete || t.transport_error){
    entry.title=!t.complete?`Chưa lưu được phản hồi ${label}`:`Chưa nhận được kết quả ${label}`;
    entry.message=reconciledBy?'Kết quả về sau đã được đối soát bằng một lượt tra cứu riêng. Dòng gốc giữ nguyên để thấy chỗ gián đoạn.':`${reasons[t.transport_error || ''] || 'Order chưa lưu được kết quả lượt gọi này.'} Chưa thể kết luận thao tác thành công hay thất bại.`;
    entry.tone=reconciledBy?'normal':'warning';return entry;
  }
  if(query){
    if(t.http_status===404){entry.title=`Chưa có kết quả ${label} được lưu`;entry.message='Chưa thấy bản ghi ở lần tra cứu này; đây không phải một lần từ chối nghiệp vụ.';return entry;}
    if(t.http_status===200 && body.status==='SUCCEEDED'){
      entry.title=action==='charge'?'Đã tìm thấy khoản thu trước đó':`Đã tìm thấy kết quả ${label} trước đó`;
      entry.message=`Dùng kết quả đã lưu của cùng mã thao tác, không ${label} lần hai.`;return entry;
    }
    if(t.http_status===200 && body.status==='FAILED'){
      entry.title=`Đã xác định ${label} bị từ chối`;entry.message=reasons[body.result?.error || ''] || 'Operation đã có kết quả thất bại dứt khoát được lưu.';entry.tone='error';return entry;
    }
    if(t.http_status===200 && body.status==='PENDING'){entry.title=`Yêu cầu ${label} vẫn đang xử lý`;entry.message='HTTP tra cứu thành công nhưng operation chưa có kết quả cuối cùng.';entry.tone='warning';return entry;}
  }
  if((t.http_status || 0)>=500){entry.title=`Tạm thời chưa thể ${label}`;entry.message='Service trả lỗi tạm thời. Saga chỉ thử lại khi còn lượt; chưa coi operation là thất bại dứt khoát.';entry.tone='warning';return entry;}
  if((t.http_status || 0)>=400){entry.title=body.error==='INSUFFICIENT_FUNDS'?'Ví không đủ số dư':`Yêu cầu ${label} bị từ chối`;entry.message=reasons[body.error || ''] || 'Mở chi tiết để xem lý do service từ chối.';entry.tone='error';return entry;}
  if(action==='reserve'){entry.title='Đã giữ hàng cho đơn';entry.message=`Giữ ${body.reservation?.quantity ?? request.quantity ?? ''} sản phẩm; tồn khả dụng đã được cập nhật.`;}
  if(action==='charge'){entry.title='Đã ghi nhận thanh toán';entry.message=`Khoản thu ${money(body.payment?.amount ?? request.amount)} đã được lưu tại Payment.`;}
  if(action==='refund'){entry.title='Đã hoàn tiền';entry.message='Payment ghi khoản hoàn mới, giữ nguyên lịch sử khoản thu gốc.';}
  if(action==='release'){entry.title='Đã trả hàng về kho';entry.message='Reservation được giải phóng; số hàng này có thể được đặt lại.';}
  return entry;
}
function describeWorkflow(e:WorkflowEvent):LogEntry {
  const intent=parseBody(e.intent);const label=actions[intent.action || ''] || 'bước đang chờ';
  let title='Đã cập nhật tiến trình đơn';let message=`Bước hiện tại: ${e.step}.`;let tone:LogEntry['tone']='normal';
  switch(e.event){
    case 'CREATED':title='Đã lưu đơn và tiến trình Saga';message='Mã thao tác được giữ để phục hồi cùng đơn khi có gián đoạn.';break;
    case 'RETRY_PENDING':title=`Chờ thử lại ${label}`;message=reasons[e.error || ''] || 'Chưa có kết quả cuối cùng; worker nền đã lên lịch thử lại.';tone='warning';break;
    case 'RETRY_STARTED':title=`Worker nền đang thử lại ${label}`;message='Tiếp tục từ bước đã lưu, dùng cùng mã thao tác.';break;
    case 'RETRY_LIMIT_REACHED':title='Đã hết lượt thử lại, chờ xử lý';message='Saga dừng tự động. Tiền và hàng giữ theo trạng thái đã ghi nhận; chưa báo hoàn tất.';tone='warning';break;
    case 'COMPENSATION_PAUSED':title='Đang bù · hết lượt thử, chờ khắc phục';message='Giữ COMPENSATING và các bước bù còn thiếu. Chưa refund xong thì chưa release hoặc hủy đơn.';tone='warning';break;
    case 'PAYMENT_RECOVERY_WAIT':title='Chờ Payment phục hồi để đối soát khoản thu';message='Đã hết lượt đối soát hiện tại. Đơn vẫn RECOVERING; dừng gọi operation liên tục và chờ phiên Payment mới.';tone='warning';break;
    case 'PAYMENT_RECOVERY_DETECTED':title='Payment đã phục hồi, tự đối soát khoản thu';message='Order phát hiện phiên Payment mới và cấp một đợt đối soát có giới hạn, dùng charge ID cũ.';break;
    case 'RESUME_REQUESTED':title='Đã cấp lượt mới để tiếp tục Saga';message='Người vận hành tiếp tục cùng tiến trình, không tạo checkout mới.';break;
    case 'RECOVERY_STARTED':title='Order đã khởi động lại, bắt đầu phục hồi đơn';message=`Đọc tiến trình đã lưu để tiếp tục ${label}.`;break;
    case 'RECOVERY_BLOCKED':title='Order đã khởi động lại, đơn vẫn chờ xử lý';message=e.status==='RECOVERING'?'Giữ nguyên trạng thái chưa rõ khoản thu; chờ Payment phục hồi để tự đối soát.':'Giữ nguyên giới hạn retry đã hết; cần tiếp tục chủ động sau khi khắc phục lỗi.';tone='warning';break;
    case 'OPERATION_RECONCILED':title=`Đã đối soát kết quả ${label}`;message='Đã kiểm tra kết quả tại dịch vụ xử lý; dùng bản ghi đã lưu để tiếp tục.';break;
    default:
      if(e.status==='CONFIRMED'){title='Đơn hàng đã được xác nhận';message='Order cập nhật DB nội bộ; không có một API confirm riêng.';}
      else if(e.status==='CANCELLED'){title='Đã hoàn tất hủy đơn';message='Các bước bù cần thiết đã xong. Order ghi nhận hủy trong DB nội bộ.';}
      else if(e.step==='AWAIT_PAYMENT'){title='Hàng đã giữ, chờ bạn thanh toán';message='Worker dừng ở đây, không tự trừ ví.';}
      else if(e.step==='REFUND_PENDING'){title='Bắt đầu hoàn tiền cho đơn không thể xác nhận';message='Phải hoàn tiền xong trước khi trả hàng và hoàn tất hủy.';}
      else if(e.step==='RELEASE_PENDING'){title='Chuyển sang trả hàng về kho';message='Hệ thống cần giải phóng số hàng đã giữ trước khi hoàn tất hủy.';}
      else if(e.step==='CHARGE_PENDING'){title='Chuẩn bị xử lý thanh toán';message='Tiếp tục với số tiền của đơn do server tính.';}
      else if(e.step==='CONFIRM_PENDING'){title='Thanh toán đã ghi nhận, chuẩn bị xác nhận đơn';message='Bước xác nhận được xử lý nội bộ tại Order.';}
      else if(e.step==='CANCEL_PENDING'){title='Chuẩn bị ghi nhận hủy đơn';message='Bước hủy cuối cùng được xử lý nội bộ tại Order.';}
  }
  return {id:`saga:${e.id}`,time:e.created_at,kind:'workflow',source:'Order · xử lý nội bộ',title,message,tone,raw:e};
}
function describeProcess(e:ProcessEvent):LogEntry|null {
  const service=e.service[0]?.toUpperCase()+e.service.slice(1);
  const entry:LogEntry={id:`event:${e.time}:${e.event}:${e.service}:${e.orderId || ''}:${e.action || ''}:${e.pid || ''}`,time:e.time,kind:'service',source:'Launcher',title:'',message:'',tone:'normal',raw:e};
  if(e.event==='CLIENT_HTTP'){
    entry.kind='http';entry.source=`UI → ${service}`;entry.client=e;
    const action=e.path?.endsWith('/resume')?'tiếp tục Saga':e.path?.includes('/faults/')?'gỡ lỗi hoàn tiền':e.path?.endsWith('/pay')?'thanh toán':e.path?.endsWith('/cancel')?'hủy đơn':'tạo đơn';
    entry.title=Number(e.status)>=400?e.transportError?`Chưa nhận được phản hồi cho yêu cầu ${action}`:`Yêu cầu ${action} bị từ chối`:`Đã tiếp nhận yêu cầu ${action}`;
    entry.message=Number(e.status)>=400?'Mở chi tiết để xem phản hồi. Không suy ra kết quả tiền/hàng từ lỗi kết nối.':action==='gỡ lỗi hoàn tiền'?'Payment đã bỏ chặn refund cho đơn này.':'Đây là phản hồi tiếp nhận yêu cầu; theo dõi các bước phía sau để biết kết quả cuối cùng.';
    entry.tone=Number(e.status)>=400?'warning':'normal';return entry;
  }
  switch(e.event){
    case 'F4_OUTAGE_STARTED':entry.title='Payment đang dừng theo kịch bản F4';entry.message='Launcher đã hẹn giờ tự khởi động lại cùng DB. Order vẫn phải query operation để biết kết quả khoản thu.';entry.tone='warning';break;
    case 'F4_RESTORE_STARTED':entry.title='Đang tự khởi động lại Payment';entry.message='Chờ process Payment vượt qua kiểm tra sẵn sàng.';break;
    case 'F4_RESTORE_COMPLETED':entry.title='Payment đã phục hồi sau F4';entry.message='Service đã sẵn sàng. Saga tự đối soát ID cũ; đây chưa phải kết luận khoản thu thành công.';break;
    case 'F4_RESTORE_FAILED':entry.title='Chưa khởi động lại được Payment';entry.message='Đơn vẫn giữ trạng thái đã lưu. Mở chi tiết để xem lỗi; có thể khôi phục service thủ công.';entry.tone='error';break;
    case 'F4_RESTORE_CANCELLED':entry.title='Đã hủy lịch tự khôi phục Payment';entry.message='Người vận hành chủ động dừng service; launcher sẽ không tự bật lại theo timer cũ.';break;
    case 'SERVICE_CONTROL_REQUESTED':entry.title=e.action==='start'?`Đang khởi động lại ${service}`:`Đã yêu cầu dừng ${service}`;entry.message='Launcher đang điều khiển process của lab.';break;
    case 'SERVICE_CONTROL_SUCCEEDED':entry.title=e.action==='start'?`${service} đã khởi động xong`:`${service} đã dừng`;entry.message=e.action==='start'?'Service đã qua kiểm tra sẵn sàng. Nếu Saga hết lượt retry, cần bấm tiếp tục.':'Các service còn lại tiếp tục hoạt động.';break;
    case 'SERVICE_CONTROL_FAILED':entry.title=`Chưa điều khiển được ${service}`;entry.message='Mở chi tiết để xem lỗi từ launcher.';entry.tone='error';break;
    case 'READY':entry.title=`${service} sẵn sàng nhận yêu cầu`;entry.message=`Process ${e.pid ?? ''} đã mở cổng phục vụ.`;break;
    case 'PROCESS_KILLED':entry.title=`${service} đã bị dừng đột ngột`;entry.message='Trạng thái nghiệp vụ phải được đối chiếu từ DB khi phục hồi.';entry.tone='warning';break;
    case 'PROCESS_STOPPED':entry.title=`${service} đã đóng`;entry.message='Launcher đã dừng process và giữ dữ liệu.';break;
    case 'PROCESS_EXITED':return null; // The corresponding stopped/killed event carries the useful explanation.
    case 'PAYMENT_CHARGE_COMMITTED_BEFORE_RESPONSE':entry.title='Payment đã thu tiền nhưng chưa gửi phản hồi';entry.message='Marker F4: khoản thu đã commit trước khi process bị dừng.';entry.tone='warning';break;
    case 'COORDINATOR_BEFORE_CHARGE_OUTCOME':entry.title='Order dừng trước khi lưu kết quả thu tiền';entry.message='Marker F6: Payment đã commit; trace gốc chưa lưu response. Cần đối soát bằng ID cũ.';entry.tone='warning';break;
    case 'COORDINATOR_BEFORE_REFUND_OUTCOME':entry.title='Order dừng sau hoàn tiền, trước khi lưu kết quả';entry.message='Marker F6: refund đã commit; Order còn REFUND_PENDING. Restart sẽ query refund ID cũ rồi trả hàng.';entry.tone='warning';break;
    default:return null;
  }
  return entry;
}
export function buildLogEntries(traces:Trace[],history:WorkflowEvent[],events:ProcessEvent[]):LogEntry[]{
  return [...traces.map(t=>describeTrace(t,traces)),...history.map(describeWorkflow),...events.map(describeProcess).filter((e):e is LogEntry=>!!e)].sort((a,b)=>b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
}
